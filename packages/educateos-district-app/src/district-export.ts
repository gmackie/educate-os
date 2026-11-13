// The whole-district export (SCHO-364): what a district administrator takes away when the district
// leaves EducateOS, or keeps as its own copy. One ZIP of JSON records, in the shapes the district's
// stores keep them, plus every held content file under its SHA-256 digest. The format is described
// in docs/educateos/educateos-archive-format.md ("District export"); its schemas are in routes.ts.
import { EducateOsError, type ContentDigest, type DistrictDirectorySnapshot, type OfferingId, type PrincipalId } from "@educateos/contracts";
import type { ContentRef } from "@educateos/learning-artifacts";
import { writeZip } from "@educateos/zip";
import { DISTRICT_EXPORT_EXCLUSIONS, DISTRICT_EXPORT_FORMAT, DistrictExportManifest } from "./routes.ts";
import type { DistrictAppStores } from "./stores.ts";

/**
 * The most held content one export carries, in bytes, before it is zipped. The export is built in
 * memory and answered in one response, so a district past this is refused rather than risk the
 * Worker's memory; a streamed export to the district's own R2 is the follow-up.
 */
export const MAX_DISTRICT_EXPORT_CONTENT_BYTES = 32 * 1024 * 1024;

/** Where held content with `digest` is in the archive. */
export const contentPath = (digest: ContentDigest): string => `content/${digest.slice("sha256:".length)}`;

const encoder = new TextEncoder();
const json = (value: unknown): Uint8Array => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

/** The per-offering stores, each read by offering ID and written as `offerings/<id>/<name>.json`. */
function offeringReaders(stores: DistrictAppStores): Record<string, (offeringId: OfferingId) => Promise<unknown>> {
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
  };
}

/**
 * Builds the whole-district export from `stores`. The caller has already been allowed `export` on
 * the district. Personal workspaces are left out, as is every artifact in one, except the revisions
 * a student submitted from it, which are part of the course record.
 *
 * @throws EducateOsError `unavailable` past {@link MAX_DISTRICT_EXPORT_CONTENT_BYTES}.
 */
export async function buildDistrictExport(
  stores: DistrictAppStores,
  snapshot: DistrictDirectorySnapshot,
  exportedBy: PrincipalId,
  exportedAt: Date,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; manifest: DistrictExportManifest }> {
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

  // Held content, once per digest; anything held elsewhere is named, not copied.
  const content = new Map<string, Uint8Array>();
  const notCopied = new Map<string, DistrictExportManifest["notCopied"][number]>();
  let contentBytes = 0;
  const collect = async (ref: ContentRef) => {
    if (ref.backend === "external" || ref.backend === "registered") {
      notCopied.set(ref.digest, { digest: ref.digest, backend: ref.backend, reference: ref.backend === "external" ? ref.key : `${ref.provider}:${ref.key}` });
      return;
    }
    const path = contentPath(ref.digest);
    if (content.has(path)) return;
    const bytes = await stores.artifactContent.read(ref);
    contentBytes += bytes.byteLength;
    if (contentBytes > MAX_DISTRICT_EXPORT_CONTENT_BYTES) {
      throw new EducateOsError("unavailable", `The district holds more than ${MAX_DISTRICT_EXPORT_CONTENT_BYTES / 1024 / 1024} MiB of work, more than one export response carries yet.`);
    }
    content.set(path, bytes);
  };
  for (const revision of revisions) await collect(revision.content);
  for (const material of assessment.starterMaterials) await collect(material.content);

  const guardianRelationships = (
    await Promise.all(snapshot.principals.filter((p) => p.kind === "student").map((p) => stores.guardianRelationships.listForStudent(p.id)))
  ).flat();
  const configRevisions = await stores.config.list();

  const files = new Map<string, Uint8Array>([
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
    ...content,
  ]);
  let offeringFiles = 0;
  for (const offering of snapshot.offerings) {
    for (const [name, read] of Object.entries(offeringReaders(stores))) {
      const value = await read(offering.id);
      if (value === undefined) continue;
      files.set(`offerings/${offering.id}/${name}.json`, json(value));
      offeringFiles += 1;
    }
  }

  const paths = [...files.keys()].toSorted();
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
    },
    files: paths,
    notCopied: [...notCopied.values()].toSorted((a, b) => a.digest.localeCompare(b.digest)),
    excluded: [...DISTRICT_EXPORT_EXCLUSIONS],
  });
  const bytes = await writeZip([{ path: "manifest.json", bytes: json(manifest) }, ...paths.map((path) => ({ path, bytes: files.get(path)! }))]);
  return { bytes, manifest };
}
