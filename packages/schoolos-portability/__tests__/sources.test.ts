import { describe, expect, it } from "vitest";
import {
  ActivityId,
  ContentItemId,
  DistrictId,
  PrincipalId,
  ResourceId,
  SchoolId,
  SubmissionId,
  type OfferingId,
  type Scope,
} from "@schoolos/contracts";
import {
  AssignmentId,
  FeedbackCommentId,
  InMemoryAssessmentRecordStore,
  type AssessmentState,
  type AssignmentBinding,
  type FeedbackComment,
  type SubmissionSnapshot,
} from "@schoolos/assessment";
import { compileDistrictConfig, SHIPPED_REGISTRY } from "@schoolos/config";
import { InMemoryContentStudioStorage, type ContentItem } from "@schoolos/content-studio";
import { sha256Digest, type ArtifactView } from "@schoolos/learning-artifacts";
import { DEFAULT_POLICY_RULES } from "@schoolos/policy";
import type { RightsMode } from "@schoolos/registry";
import {
  DistrictStudentRecordSource,
  learnerResourceExportEnabled,
  validateArchive,
  withLearnerResourceExport,
} from "../src/index.ts";
import { doc, O, P, setup } from "./setup.ts";

const NF = DistrictId.parse("dst_northfield");
const amara = P.amara.principal.principalId;
const elena = P.elena.principal.principalId;
const morgan = P.morgan.principal.principalId;
const AT = "2026-10-01T15:00:00.000Z";
const encoder = new TextEncoder();
const offering = (offeringId: string): Extract<Scope, { level: "offering" }> =>
  ({ level: "offering", districtId: NF, schoolId: SchoolId.parse("sch_nf-high"), offeringId: offeringId as OfferingId });

function assignment(id: string, title: string, feedbackVisibility: AssignmentBinding["feedbackVisibility"]): AssignmentBinding {
  return {
    id: AssignmentId.parse(id),
    districtId: NF,
    offeringId: O.bioFall,
    activityId: ActivityId.parse(`act_${id.slice(4)}`),
    title,
    dueAt: "2026-10-02T00:00:00.000Z",
    latePolicy: { kind: "refuse" },
    attemptsAllowed: 3,
    permittedArtifactTypes: ["document"],
    feedbackVisibility,
    createdBy: morgan,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function submission(id: string, assignmentId: string, student: PrincipalId, attempt: number, work: ArtifactView, withdrawnAt?: string): SubmissionSnapshot {
  return {
    id: SubmissionId.parse(id),
    districtId: NF,
    assignmentId: AssignmentId.parse(assignmentId),
    offeringId: O.bioFall,
    studentPrincipalId: student,
    attempt,
    items: [{
      artifactId: work.artifact.id,
      revisionId: work.head.id,
      digest: work.head.content.digest,
      artifactType: work.artifact.type,
      mediaType: work.head.mediaType,
      sizeBytes: work.head.sizeBytes,
      aiAssistance: work.head.aiAssistance,
    }],
    submissionDigest: work.head.content.digest,
    submittedAt: AT,
    timing: "on-time",
    channel: "http",
    ...(withdrawnAt === undefined ? {} : { withdrawnAt }),
  };
}

let commentCount = 0;
function comment(body: string, options: Partial<Pick<FeedbackComment, "anchor" | "source">> = {}): FeedbackComment {
  return {
    id: FeedbackCommentId.parse(`fbc_c${++commentCount}`),
    body,
    source: options.source ?? { kind: "teacher" },
    enteredBy: morgan,
    enteredAt: "2026-10-03T09:00:00.000Z",
    ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
  };
}

/** A released Content Studio item with its snapshot, release and class binding. */
async function release(studio: InMemoryContentStudioStorage, options: {
  name: string;
  title: string;
  uses: RightsMode[];
  licenseUri?: string;
  bytes: string;
  boundTo: string;
}) {
  const bytes = encoder.encode(options.bytes);
  const digest = await sha256Digest(bytes);
  const resourceId = ResourceId.parse(`rsc_${options.name}`);
  const itemId = ContentItemId.parse(`cit_${options.name}`);
  const locator = `https://publisher.example/${options.name}`;
  const item: ContentItem = {
    id: itemId,
    districtId: NF,
    resourceId,
    revision: 1,
    state: "released",
    targetScope: offering(options.boundTo),
    submittedBy: morgan,
    submittedAt: AT,
    source: { kind: "url", submittedUrl: locator, finalUrl: locator, hops: [] },
    contentType: "text",
    snapshotDigest: digest,
    byteLength: bytes.byteLength,
    scan: undefined,
    title: options.title,
    canonicalUrl: locator,
    lang: undefined,
    license: { status: "absent", hints: [] },
    rights: { proposed: "link", current: options.uses.at(-1)!, changes: [] },
    checks: undefined,
    ai: undefined,
    decision: undefined,
  };
  await studio.putItem(item);
  await studio.putSnapshot(digest, bytes);
  await studio.addRelease({
    descriptor: {
      id: resourceId,
      release: { version: "1.0.0", releasedAt: AT, contentDigest: digest },
      kind: "document",
      title: options.title,
      locator,
      license: {
        name: options.licenseUri === undefined ? "No recognized license" : "CC BY 4.0",
        ...(options.licenseUri === undefined ? {} : { licenseUri: options.licenseUri }),
        permittedUses: options.uses,
        verification: { status: "claimed" },
      },
      audience: {},
      accessibility: { features: [], hazards: [] },
      alignments: [],
      review: { status: "approved", reviewer: morgan, reviewedAt: AT },
      provenance: { source: "official", sourceUri: locator, retrievedAt: AT, sourceRevision: digest },
    },
    itemId,
    scope: offering(options.boundTo),
    alignmentEvidence: [],
  });
  await studio.addBinding({ resourceId, version: "1.0.0", offering: offering(options.boundTo), boundBy: morgan, boundAt: AT });
}

/**
 * Amara's Biology records as E01 and C03 hold them, with what an export must leave out marked in
 * capitals: a withdrawn attempt, an AI suggestion, feedback not yet released, a peer's submission,
 * and a resource from a class she never took.
 */
async function amarasRecords(options: { resourceExport: boolean }) {
  const assessment = new InMemoryAssessmentRecordStore();
  const studio = new InMemoryContentStudioStorage();
  const env = setup({
    rules: withLearnerResourceExport(DEFAULT_POLICY_RULES, options.resourceExport),
    source: (directory) => new DistrictStudentRecordSource({ assessment, studio, directory }),
  });
  const bio = await env.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  // The draft stays her work, exported as an artifact; only the submission she withdrew is left out.
  const draft = await env.artifacts.createArtifact(P.amara, doc(bio.id, "First draft.", "Lab draft"));
  const lab = await env.artifacts.createArtifact(P.amara, doc(bio.id, "Osmosis: the potato lost mass.", "Osmosis lab report"));
  const essay = await env.artifacts.createArtifact(P.amara, doc(bio.id, "Cells, an essay.", "Cell essay"));
  const elenaBio = await env.workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
  const peer = await env.artifacts.createArtifact(P.elena, doc(elenaBio.id, "PEER-WORK.", "PEER lab"));

  const state: AssessmentState = {
    assignments: [assignment("asg_osmosis", "Osmosis lab", "when-shared"), assignment("asg_essay", "Cell essay", "when-final")],
    starterMaterials: [],
    submissions: [
      submission("sub_amara-osmosis-1", "asg_osmosis", amara, 1, draft, "2026-10-01T15:30:00.000Z"),
      submission("sub_amara-osmosis-2", "asg_osmosis", amara, 2, lab),
      submission("sub_amara-essay", "asg_essay", amara, 1, essay),
      submission("sub_elena-osmosis", "asg_osmosis", elena, 1, peer),
    ],
    feedback: [
      {
        submissionId: SubmissionId.parse("sub_amara-osmosis-2"),
        state: "shared-with-student",
        comments: [
          comment("Good method.", { anchor: { artifactId: lab.artifact.id, revisionId: lab.head.id, region: { kind: "text-range", start: 0, end: 7 } } }),
          comment("AI-SUGGESTION: mention turgor.", { source: { kind: "suggested", suggester: { kind: "ai", modelId: "workers-ai/example-model" } } }),
          comment("Sign in with password=hunter2hunter2 to see your grade."),
        ],
        scores: [],
        updatedAt: AT,
      },
      { submissionId: SubmissionId.parse("sub_amara-essay"), state: "shared-with-student", comments: [comment("NOT-YET-FINAL note.")], scores: [], updatedAt: AT },
      { submissionId: SubmissionId.parse("sub_elena-osmosis"), state: "final", comments: [comment("PEER-FEEDBACK.")], scores: [], updatedAt: AT },
    ],
    gradeProposals: [],
    gradeVersions: [],
  };
  await assessment.commit(state, 0);

  await release(studio, { name: "diffusion", title: "Diffusion, openly licensed", uses: ["link", "embed", "excerpt", "licensed-copy"], licenseUri: "https://creativecommons.org/licenses/by/4.0/", bytes: "Diffusion moves particles down a gradient.", boundTo: "off_nf-bio-fall-p2" });
  await release(studio, { name: "textbook", title: "Biology textbook", uses: ["link", "embed", "excerpt", "licensed-copy"], bytes: "LICENSED-TEXTBOOK-CONTENT", boundTo: "off_nf-bio-fall-p2" });
  await release(studio, { name: "history", title: "OTHER-CLASS reading", uses: ["link"], bytes: "OTHER-CLASS", boundTo: "off_nf-ushist-fall-p5" });

  await env.completeFallTerm();
  const exported = await env.exporter.exportStudentArchive(P.amara);
  const archive = await validateArchive(exported.bytes);
  const everything = new TextDecoder().decode(exported.bytes);
  return { exported, archive, everything, withdrawnDigest: draft.head.content.digest };
}

describe("the district record source (E01 submissions and feedback, C03 resources)", () => {
  it("exports the learner's live submissions and released teacher feedback with its anchor", async () => {
    const { archive, withdrawnDigest } = await amarasRecords({ resourceExport: false });

    expect(archive.submissions.flatMap((s) => s.parts.map((p) => p.digest))).not.toContain(withdrawnDigest);
    expect(archive.submissions.map((s) => [s.activity, s.parts.length])).toEqual([["Cell essay", 1], ["Osmosis lab", 1]]);
    const osmosis = archive.submissions.find((s) => s.activity === "Osmosis lab")!;
    expect(archive.feedback).toEqual([expect.objectContaining({
      submission: osmosis.id,
      author: "staff-1",
      body: "Good method.",
      anchor: { part: 1, region: { kind: "text-range", start: 0, end: 7 } },
    })]);
  });

  it("leaves out suggestions, unreleased feedback, peers' records and other classes' resources", async () => {
    const { everything } = await amarasRecords({ resourceExport: true });
    for (const forbidden of ["AI-SUGGESTION", "NOT-YET-FINAL", "PEER-", "OTHER-CLASS", "LICENSED-TEXTBOOK-CONTENT"]) {
      expect(everything).not.toContain(forbidden);
    }
  });

  it("reports feedback withheld for holding secret-shaped text", async () => {
    const { exported } = await amarasRecords({ resourceExport: false });
    expect(exported.withheld).toEqual([{ kind: "feedback", label: "Feedback", found: expect.arrayContaining([expect.any(String)]) }]);
  });

  it("cites class resources as references while the district's export grant is off", async () => {
    const { archive } = await amarasRecords({ resourceExport: false });
    expect(archive.resources.map((r) => [r.title, r.reference?.url, r.content])).toEqual([
      ["Diffusion, openly licensed", "https://publisher.example/diffusion", undefined],
      ["Biology textbook", "https://publisher.example/textbook", undefined],
    ]);
    expect(archive.provenance.decisions.filter((d) => d.item.startsWith("res")).map((d) => [d.action, d.ruleId])).toEqual([
      ["read", "course.student.read"],
      ["read", "course.student.read"],
    ]);
  });

  it("copies an openly licensed resource once the grant is on, and never one without a recognized license", async () => {
    const { archive } = await amarasRecords({ resourceExport: true });
    const diffusion = archive.resources.find((r) => r.title === "Diffusion, openly licensed")!;
    const textbook = archive.resources.find((r) => r.title === "Biology textbook")!;

    expect(new TextDecoder().decode(archive.content(diffusion.content!.path))).toBe("Diffusion moves particles down a gradient.");
    expect(textbook).toEqual(expect.not.objectContaining({ content: expect.anything() }));
    expect(archive.provenance.decisions.find((d) => d.item === diffusion.id)).toEqual({ item: diffusion.id, action: "export", ruleId: "portability.learner.resource-export" });
    expect(archive.manifest.items.find((i) => i.path === diffusion.content!.path)!.rights).toEqual({ mode: "licensed-copy", redistribution: "permitted", license: "CC BY 4.0" });
  });
});

/** The compiled desired state of a minimal Northfield configuration, with `portability` as its student-portability entry. */
function compiled(portability: unknown) {
  const document = {
    apiVersion: "schoolos.dev/v1alpha1",
    district: "dst_northfield",
    profile: "us-k12-conservative",
    identity: { provider: "district-sso" },
    rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
    modules: { "core-learning": "enabled", "learning-artifacts": "enabled", ...(portability === undefined ? {} : { "student-portability": portability }) },
    rollout: { target: "all-active-offerings", requiresAdminActivation: false },
  };
  const result = compileDistrictConfig(document, SHIPPED_REGISTRY);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.compiled.desired;
}

describe("the learner resource export switch", () => {
  it("is off unless the student-portability pack is enabled with it turned on", () => {
    expect(learnerResourceExportEnabled(compiled(undefined))).toBe(false);
    expect(learnerResourceExportEnabled(compiled("enabled"))).toBe(false);
    expect(learnerResourceExportEnabled(compiled({ state: "disabled", config: { redistributableResourceExport: true } }))).toBe(false);
    expect(learnerResourceExportEnabled(compiled({ state: "enabled", config: { redistributableResourceExport: true } }))).toBe(true);
  });

  it("adds the grant after every existing rule, and only when on", () => {
    expect(withLearnerResourceExport(DEFAULT_POLICY_RULES, false)).toEqual([...DEFAULT_POLICY_RULES]);
    const on = withLearnerResourceExport(DEFAULT_POLICY_RULES, true);
    expect(on.slice(0, -1)).toEqual([...DEFAULT_POLICY_RULES]);
    expect(on.at(-1)!.id).toBe("portability.learner.resource-export");
  });
});
