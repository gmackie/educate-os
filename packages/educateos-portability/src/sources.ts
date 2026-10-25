import { EducateOsError, type PrincipalId, type ResourceId, type Scope } from "@educateos/contracts";
import type { AcademicStore } from "@educateos/academics";
import type { AssessmentRecordStore, AssessmentState, FeedbackState } from "@educateos/assessment";
import { MEDIA_TYPES, type ContentStudioStorage, type StudioRelease } from "@educateos/content-studio";
import type { ResourceDescriptor } from "@educateos/registry";
import type { SourceRights } from "./archive.ts";
import type { FeedbackSourceRecord, ResourceSourceRecord, StudentRecordSource, SubmissionSourceRecord } from "./records.ts";

/** What a {@link DistrictStudentRecordSource} reads. It writes nothing. */
export interface DistrictStudentRecordSourceOptions {
  /** The district's assessment records (E01): submissions and their feedback. */
  assessment: AssessmentRecordStore;
  /** The district's Content Studio storage (C03): resource releases, their class bindings and snapshots. */
  studio: ContentStudioStorage;
  /** The district's academic directory, for the learner's enrollments. */
  directory: AcademicStore;
}

const FEEDBACK_ORDER: readonly FeedbackState[] = ["draft", "shared-with-student", "final"];

/**
 * The district's real {@link StudentRecordSource}, read from the assessment service's records (E01)
 * and the Content Studio (C03).
 *
 * - **Submissions**: the learner's live submissions, each with its pinned revisions. A withdrawn
 *   submission is not part of the learner's record and is left out.
 * - **Feedback**: one record per comment on the learner's submissions, with its anchor. A comment
 *   is `shared-with-learner` exactly when the assessment service would show it to the learner
 *   (`AssessmentService.getFeedback`): the teacher's own, once the assignment's feedback visibility
 *   allows. A suggestion is never shown, so it is always `teacher-only`.
 * - **Resources**: C03 has no record of a learner's work citing a resource, so a release counts as
 *   cited when it was bound to a class the learner was enrolled in, active or not. Each release is
 *   one record, scoped to the offering of a class it was bound to (an active one first), which is
 *   how the learner reached it, and classified `course`, as class material is.
 *
 * The exporter re-checks every record against the directory and the policy engine, so this source
 * only has to describe the records faithfully.
 */
export class DistrictStudentRecordSource implements StudentRecordSource {
  readonly #assessment: AssessmentRecordStore;
  readonly #studio: ContentStudioStorage;
  readonly #directory: AcademicStore;

  constructor(options: DistrictStudentRecordSourceOptions) {
    this.#assessment = options.assessment;
    this.#studio = options.studio;
    this.#directory = options.directory;
  }

  async submissions(principalId: PrincipalId): Promise<SubmissionSourceRecord[]> {
    const { state } = await this.#assessment.load();
    return liveSubmissionsOf(state, principalId).map((submission) => ({
      id: submission.id,
      ownerPrincipalId: submission.studentPrincipalId,
      offeringId: submission.offeringId,
      activityTitle: assignmentOf(state, submission.assignmentId).title,
      submittedAt: submission.submittedAt,
      revisions: submission.items.map(({ artifactId, revisionId, digest }) => ({ artifactId, revisionId, digest })),
    }));
  }

  async feedback(principalId: PrincipalId): Promise<FeedbackSourceRecord[]> {
    const { state } = await this.#assessment.load();
    const records: FeedbackSourceRecord[] = [];
    for (const submission of liveSubmissionsOf(state, principalId)) {
      const feedback = state.feedback.find((f) => f.submissionId === submission.id);
      if (feedback === undefined) continue;
      const visibleFrom: FeedbackState = assignmentOf(state, submission.assignmentId).feedbackVisibility === "when-final" ? "final" : "shared-with-student";
      const released = FEEDBACK_ORDER.indexOf(feedback.state) >= FEEDBACK_ORDER.indexOf(visibleFrom);
      for (const comment of feedback.comments) {
        records.push({
          id: comment.id,
          subjectPrincipalId: submission.studentPrincipalId,
          offeringId: submission.offeringId,
          submissionId: submission.id,
          authorPrincipalId: comment.enteredBy,
          visibility: released && comment.source.kind === "teacher" ? "shared-with-learner" : "teacher-only",
          createdAt: comment.enteredAt,
          body: comment.body,
          ...(comment.anchor === undefined ? {} : { anchor: comment.anchor }),
        });
      }
    }
    return records;
  }

  async resources(principalId: PrincipalId): Promise<ResourceSourceRecord[]> {
    const { snapshot } = await this.#directory.load();
    const enrollments = snapshot.enrollments.filter((e) => e.principalId === principalId && e.role === "student");
    // An active class first, so a release bound to a class the learner is still in is described there.
    const rank = (offeringId: string) => {
      const enrollment = enrollments.find((e) => e.offeringId === offeringId);
      return enrollment === undefined ? -1 : enrollment.status === "active" ? 0 : 1;
    };
    const [bindings, releases] = await Promise.all([this.#studio.listBindings(), this.#studio.listReleases()]);
    const byRelease = new Map<string, Extract<Scope, { level: "offering" }>>();
    for (const binding of bindings.toSorted((a, b) => rank(a.offering.offeringId) - rank(b.offering.offeringId))) {
      if (rank(binding.offering.offeringId) < 0) continue;
      const id = resourceRecordId(binding.resourceId, binding.version);
      if (!byRelease.has(id)) byRelease.set(id, binding.offering);
    }
    const records: ResourceSourceRecord[] = [];
    for (const [id, offering] of byRelease) {
      const release = releases.find((r) => resourceRecordId(r.descriptor.id, r.descriptor.release.version) === id);
      if (release !== undefined) records.push(await this.#resourceRecord(id, release, offering));
    }
    return records;
  }

  async resourceContent(resourceId: string): Promise<Uint8Array<ArrayBuffer>> {
    const { resource, version } = parseResourceRecordId(resourceId);
    const release = (await this.#studio.listReleases(resource)).find((r) => r.descriptor.release.version === version);
    const item = release === undefined ? undefined : await this.#studio.getItem(release.itemId);
    const bytes = item === undefined ? undefined : await this.#studio.getSnapshot(item.snapshotDigest);
    if (bytes === undefined) throw new EducateOsError("not-found", `resource ${resourceId} has no held copy.`);
    return new Uint8Array(bytes);
  }

  async #resourceRecord(id: string, release: StudioRelease, offering: Extract<Scope, { level: "offering" }>): Promise<ResourceSourceRecord> {
    const { descriptor } = release;
    const item = await this.#studio.getItem(release.itemId);
    const url = URL.canParse(descriptor.locator) && new URL(descriptor.locator).protocol === "https:" ? descriptor.locator : undefined;
    return {
      id,
      title: descriptor.title.length <= 200 ? descriptor.title : `${descriptor.title.slice(0, 199)}…`,
      scope: offering,
      classification: "course",
      rights: rightsOf(descriptor),
      ...(url === undefined ? {} : { url }),
      ...(item === undefined ? {} : { contentMediaType: MEDIA_TYPES[item.contentType] }),
    };
  }
}

/**
 * The archive rights of a release: the widest use its license permits, in the archive's
 * vocabulary. Copying it out of the district (`permitted`) needs a license the studio recognized,
 * which is the only case its license carries a `licenseUri`: every recognized license (a Creative
 * Commons license or a public-domain mark) allows redistribution, and a claim without one does not.
 */
export function rightsOf(descriptor: ResourceDescriptor): SourceRights {
  const uses = descriptor.license.permittedUses;
  const redistribution = descriptor.license.licenseUri === undefined ? "forbidden" : "permitted";
  const license = descriptor.license.name.slice(0, 200);
  if (uses.includes("licensed-copy")) return { mode: "licensed-copy", redistribution, license };
  if (uses.includes("excerpt")) return { mode: "permitted-excerpt", redistribution, license };
  if (uses.includes("embed")) return { mode: "embed" };
  return { mode: "link" };
}

function liveSubmissionsOf(state: AssessmentState, principalId: PrincipalId) {
  return state.submissions.filter((s) => s.studentPrincipalId === principalId && s.withdrawnAt === undefined);
}

function assignmentOf(state: AssessmentState, assignmentId: string) {
  const assignment = state.assignments.find((a) => a.id === assignmentId);
  if (assignment === undefined) throw new Error(`submission names a missing assignment ${assignmentId}`);
  return assignment;
}

/** A resource record's ID: the resource and the release version, `res_…@1.0.0`. */
function resourceRecordId(resource: ResourceId, version: string): string {
  return `${resource}@${version}`;
}

function parseResourceRecordId(id: string): { resource: ResourceId; version: string } {
  const [resource, version] = id.split("@");
  if (resource === undefined || version === undefined) throw new EducateOsError("not-found", `resource ${id} was not found.`);
  return { resource: resource as ResourceId, version };
}
