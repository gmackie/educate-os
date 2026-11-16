// The whole-district export (SCHO-364): what a district administrator takes away when the district
// leaves EducateOS, or keeps as its own copy. One ZIP of JSON records, in the shapes the district's
// stores keep them, plus every held content file under its SHA-256 digest. The format is described
// in docs/educateos/educateos-archive-format.md ("District export"); its schemas are in routes.ts.
//
// Streamed (SCHO-367): the records are read first, so the manifest can come first and name every
// file, but no content file is read until the ZIP stream reaches it, and each is let go once
// written. A district of any size exports within a Worker's memory: what is held at once is the
// records themselves and one content file.
import { type ContentDigest, type DistrictDirectorySnapshot, type OfferingId, type PrincipalId } from "@educateos/contracts";
import type { ContentRef } from "@educateos/learning-artifacts";
import type { ActivityDefinition, ActivityInstallation } from "@educateos/curriculum";
import type { RubricRelease } from "@educateos/assessment-ci";
import { zipStream, type ZipWriteEntry } from "@educateos/zip";
import { isoWeekOf } from "./communication/model.ts";
import { DISTRICT_EXPORT_EXCLUSIONS, DISTRICT_EXPORT_FORMAT, DistrictExportManifest } from "./routes.ts";
import type { DistrictAppStores } from "./stores.ts";

/** Where held content with `digest` is in the archive. */
export const contentPath = (digest: ContentDigest): string => `content/${digest.slice("sha256:".length)}`;

const encoder = new TextEncoder();
const json = (value: unknown): Uint8Array => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
const DAY_MS = 86_400_000;

/** The per-offering stores, each read by offering ID and written as `offerings/<id>/<name>.json`. */
function offeringReaders(stores: DistrictAppStores, snapshot: DistrictDirectorySnapshot): Record<string, (offeringId: OfferingId) => Promise<unknown>> {
  return {
    "course-content": (id) => stores.courseContent.load(id),
    discussions: (id) => stores.discussions.load(id),
    quizzes: (id) => stores.quizzes.load(id),
    gradebook: async (id) => {
      const gradebook = await stores.gradebooks.load(id);
      return gradebook.revision === 0 && gradebook.markers.length === 0 ? undefined : gradebook;
    },
    announcements: async (id) => {
      const announcements = await stores.communication.announcements.list(id);
      return announcements.length === 0 ? undefined : announcements;
    },
    // Weekly notes are kept by offering and week, with no listing: every week the term touches is
    // asked, from the week before it starts (a note sent the Sunday before) to the week it ends.
    "weekly-notes": async (id) => {
      const term = snapshot.terms.find((t) => t.id === snapshot.offerings.find((o) => o.id === id)?.termId);
      if (term === undefined) return undefined;
      const notes = [];
      const end = Date.parse(`${term.endsOn}T00:00:00Z`);
      for (let at = Date.parse(`${term.startsOn}T00:00:00Z`) - 7 * DAY_MS; at <= end; at += 7 * DAY_MS) {
        const note = await stores.communication.weeklyNotes.get(id, isoWeekOf(new Date(at)));
        if (note !== undefined) notes.push(note);
      }
      return notes.length === 0 ? undefined : notes;
    },
  };
}

/** A district export: its manifest, known before any content is read, and the ZIP as a stream. */
export interface DistrictExport {
  manifest: DistrictExportManifest;
  /** The ZIP. Content is read as the stream is pulled; a read that fails errors the stream. */
  body: ReadableStream<Uint8Array>;
}

/**
 * Builds the whole-district export from `stores`. The caller has already been allowed `export` on
 * the district. Personal workspaces are left out, as is every artifact in one, except the revisions
 * a student submitted from it, which are part of the course record.
 */
export async function buildDistrictExport(
  stores: DistrictAppStores,
  snapshot: DistrictDirectorySnapshot,
  exportedBy: PrincipalId,
  exportedAt: Date,
): Promise<DistrictExport> {
  const workspaces = (await stores.workspaces.load()).state;
  const artifacts = (await stores.artifactRecords.load()).state;
  const assessment = (await stores.assessment.load()).state;

  const courseWorkspaces = workspaces.workspaces.filter((w) => w.kind === "course");
  const courseWorkspaceIds = new Set(courseWorkspaces.map((w) => w.id));
  const submitted = new Set(assessment.submissions.flatMap((s) => s.items.map((item) => item.revisionId as string)));
  const inCourse = new Set(artifacts.artifacts.filter((a) => courseWorkspaceIds.has(a.workspaceId) && a.classification !== "personal-private").map((a) => a.id as string));
  const revisions = artifacts.revisions.filter((r) => inCourse.has(r.artifactId) || submitted.has(r.id));
  const revisionIds = new Set(revisions.map((r) => r.id as string));
  const artifactIds = new Set(revisions.map((r) => r.artifactId as string));
  for (const id of inCourse) artifactIds.add(id);
  const exportedArtifacts = artifacts.artifacts.filter((a) => artifactIds.has(a.id));

  // Held content, once per digest, read only when the stream reaches it; anything held elsewhere
  // is named, not copied.
  const content = new Map<string, () => Promise<Uint8Array>>();
  const notCopied = new Map<string, DistrictExportManifest["notCopied"][number]>();
  const collect = (ref: ContentRef) => {
    if (ref.backend === "external" || ref.backend === "registered") {
      notCopied.set(ref.digest, { digest: ref.digest, backend: ref.backend, reference: ref.backend === "external" ? ref.key : `${ref.provider}:${ref.key}` });
      return;
    }
    const path = contentPath(ref.digest);
    if (!content.has(path)) content.set(path, () => stores.artifactContent.read(ref));
  };
  for (const revision of revisions) collect(revision.content);
  for (const material of assessment.starterMaterials) collect(material.content);

  // Content Studio (SCHO-367): items, their snapshots as held content, releases and class bindings.
  const studioItems = await stores.contentStudio.listItems();
  const studioReleases = await stores.contentStudio.listReleases();
  const studioBindings = await stores.contentStudio.listBindings();
  for (const item of studioItems) {
    const path = contentPath(item.snapshotDigest as ContentDigest);
    if (content.has(path)) continue;
    content.set(path, async () => {
      const bytes = await stores.contentStudio.getSnapshot(item.snapshotDigest);
      if (bytes === undefined) throw new Error(`Content Studio item ${item.id} names a snapshot the studio does not hold`);
      return bytes;
    });
  }

  // Activities (SCHO-367): every installation an assignment or a module places, and every version
  // of each definition those installations, and the classes' course installs, were made from.
  const courseInstalls = (await Promise.all(snapshot.offerings.map((o) => stores.courseLibrary.loadInstalls(o.id)))).filter((i) => i !== undefined);
  const outlines = (await Promise.all(snapshot.offerings.map((o) => stores.courseContent.load(o.id)))).filter((o) => o !== undefined);
  const activityIds = new Set<string>(assessment.assignments.map((a) => a.activityId));
  for (const outline of outlines) {
    for (const item of outline.modules.flatMap((m) => m.items)) if (item.kind === "activity") activityIds.add(item.activityId);
  }
  const installations: ActivityInstallation[] = [];
  for (const id of [...activityIds].toSorted()) {
    const installation = await stores.curriculum.getInstallation(id as ActivityInstallation["id"]);
    if (installation !== undefined) installations.push(installation);
  }
  const definitionIds = new Set<string>([
    ...installations.map((i) => i.definitionId),
    ...courseInstalls.flatMap((i) => i.definitions.map((d) => d.definition.definitionId)),
  ]);
  const definitions: ActivityDefinition[] = [];
  for (const id of [...definitionIds].toSorted()) definitions.push(...await stores.curriculum.listVersions(id as ActivityDefinition["id"]));

  // Rubric releases (SCHO-367): every release an assignment names.
  const rubricRefs = new Map(assessment.assignments.flatMap((a) => (a.rubric === undefined ? [] : [[`${a.rubric.rubricId}@${a.rubric.version}`, a.rubric] as const])));
  const rubricReleases: RubricRelease[] = [];
  for (const key of [...rubricRefs.keys()].toSorted()) {
    const release = await stores.rubrics.get(rubricRefs.get(key)!);
    if (release !== undefined) rubricReleases.push(release);
  }

  const libraryCourses = await stores.courseLibrary.listCourses();
  const marketplacePacks = await stores.marketplacePacks.list();
  const guardianRelationships = (
    await Promise.all(snapshot.principals.filter((p) => p.kind === "student").map((p) => stores.guardianRelationships.listForStudent(p.id)))
  ).flat();
  const configRevisions = await stores.config.list();

  const records = new Map<string, Uint8Array>([
    ["directory.json", json(snapshot)],
    ["workspaces.json", json({ workspaces: courseWorkspaces, grants: workspaces.grants, closures: workspaces.closures, deletions: workspaces.deletions })],
    ["artifacts.json", json({
      artifacts: exportedArtifacts,
      revisions,
      pins: artifacts.pins.filter((pin) => revisionIds.has(pin.revisionId)),
      shares: artifacts.shares.filter((share) => artifactIds.has(share.artifactId)),
    })],
    ["assessment.json", json(assessment)],
    ["guardians.json", json({ relationships: guardianRelationships })],
    ["config.json", json({ revisions: configRevisions })],
    ["content-studio.json", json({ items: studioItems, releases: studioReleases, bindings: studioBindings })],
    ["activities.json", json({ definitions, installations })],
    ["rubrics.json", json({ releases: rubricReleases })],
    ["course-library.json", json({ courses: libraryCourses, installs: courseInstalls })],
    ["marketplace-packs.json", json({ packs: marketplacePacks })],
  ]);
  let offeringFiles = 0;
  let weeklyNotes = 0;
  for (const offering of snapshot.offerings) {
    for (const [name, read] of Object.entries(offeringReaders(stores, snapshot))) {
      const value = await read(offering.id);
      if (value === undefined) continue;
      if (name === "weekly-notes") weeklyNotes += (value as unknown[]).length;
      records.set(`offerings/${offering.id}/${name}.json`, json(value));
      offeringFiles += 1;
    }
  }

  const paths = [...records.keys(), ...content.keys()].toSorted();
  const manifest = DistrictExportManifest.parse({
    format: DISTRICT_EXPORT_FORMAT,
    districtId: snapshot.district.id,
    districtName: snapshot.district.name,
    exportedAt: exportedAt.toISOString(),
    exportedBy,
    counts: {
      schools: snapshot.schools.length,
      terms: snapshot.terms.length,
      courses: snapshot.courses.length,
      offerings: snapshot.offerings.length,
      principals: snapshot.principals.length,
      enrollments: snapshot.enrollments.length,
      courseWorkspaces: courseWorkspaces.length,
      artifacts: exportedArtifacts.length,
      revisions: revisions.length,
      contentFiles: content.size,
      assignments: assessment.assignments.length,
      submissions: assessment.submissions.length,
      feedback: assessment.feedback.length,
      gradeVersions: assessment.gradeVersions.length,
      guardianRelationships: guardianRelationships.length,
      configRevisions: configRevisions.length,
      offeringFiles,
      studioItems: studioItems.length,
      studioReleases: studioReleases.length,
      activityDefinitions: definitions.length,
      activityInstallations: installations.length,
      rubricReleases: rubricReleases.length,
      libraryCourses: libraryCourses.length,
      marketplacePacks: marketplacePacks.length,
      weeklyNotes,
    },
    files: paths,
    notCopied: [...notCopied.values()].toSorted((a, b) => a.digest.localeCompare(b.digest)),
    excluded: [...DISTRICT_EXPORT_EXCLUSIONS],
  });

  async function* entries(): AsyncIterable<ZipWriteEntry> {
    yield { path: "manifest.json", bytes: json(manifest) };
    for (const path of paths) {
      const record = records.get(path);
      yield { path, bytes: record ?? await content.get(path)!() };
    }
  }
  // Held content is mostly images, documents and audio, compressed already: stored as it is.
  return { manifest, body: zipStream(entries(), { store: (path) => path.startsWith("content/") }) };
}
