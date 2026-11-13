// SCHO-364: a district administrator exports the whole seeded Northfield showcase through the
// district API, and the archive is checked for completeness against what the API's own views say:
// directory and work counts, every submitted revision with its content, a class's modules and
// assignments. A student's personal workspace stays out, and nobody but the administrator gets it.
// SCHO-367: the export is a streamed ZIP, past the 32 MiB of held content the first version
// refused, and carries the Content Studio, activities, rubric releases, course library and
// marketplace packs.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDistrictApiClient, DistrictApiError, type DistrictApiClient, type DistrictFileClient } from "@educateos/api-client";
import type { PrincipalId } from "@educateos/contracts";
import { contentPath, DISTRICT_EXPORT_FORMAT, DistrictExportManifest, MAX_UPLOAD_BYTES } from "@educateos/district-app";
import { NORTHFIELD, NORTHFIELD_GUARDIANS, NORTHFIELD_SHOWCASE } from "@educateos/fixtures";
import { readZip } from "@educateos/zip";
import { bootDistrictApp, bootHarness, seedShowcase, showcaseResourceUrl } from "../src/index.ts";

const ADMIN = "prn_nf-district-admin" as PrincipalId;
const STUDENT = "prn_nf-student-amara" as PrincipalId;
const G1_READING = NORTHFIELD_SHOWCASE.courses.find((course) => course.offeringId === "off_nf-g1read-fall-r7")!;
const name = (id: string) => NORTHFIELD.principals.find((p) => p.id === id)!.displayName;
const LIMITS = { maxEntries: 10_000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxCompressionRatio: 1_000 };
const PRIVATE = "PRIVATE-JOURNAL-SCHO-364";
/** The held content the first, unstreamed export refused past (SCHO-364). */
const OLD_CAP = 32 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** An upload-sized PNG-signed file of distinct bytes, so no two share a digest. */
function bigPng(seed: number): Uint8Array {
  const bytes = new Uint8Array(MAX_UPLOAD_BYTES);
  bytes.set(PNG_SIGNATURE);
  let x = seed + 1;
  for (let i = PNG_SIGNATURE.length; i < bytes.length; i++) {
    x = (x * 1_103_515_245 + 12_345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return bytes;
}

describe("the whole-district export, over the seeded Northfield showcase", () => {
  let actAs: (id: string) => Promise<DistrictApiClient & DistrictFileClient>;
  let response: Response;
  let order: string[];
  let manifest: DistrictExportManifest;
  let files: ReadonlyMap<string, Uint8Array>;
  const uploads = Array.from({ length: Math.ceil(OLD_CAP / MAX_UPLOAD_BYTES) + 1 }, (_, i) => bigPng(i));
  const read = <T>(path: string): T => JSON.parse(new TextDecoder().decode(files.get(path)!)) as T;

  beforeAll(async () => {
    const [entry] = await bootHarness([NORTHFIELD]);
    const app = await bootDistrictApp(entry!);
    actAs = async (id) => {
      const subject = NORTHFIELD.principals.find((p) => p.id === id)!.externalIdentities[0]!.subject;
      return createDistrictApiClient({ baseUrl: "http://district.harness", token: await entry!.identity.issueToken(subject), fetch: (request) => app.fetch(request) });
    };
    await seedShowcase({
      showcase: NORTHFIELD_SHOWCASE,
      adminId: ADMIN,
      actAs,
      guardians: NORTHFIELD_GUARDIANS,
      guardianNames: Object.fromEntries(NORTHFIELD_GUARDIANS.map((g) => [g.guardianPrincipalId, name(g.guardianPrincipalId)])),
      resourceUrl: showcaseResourceUrl,
    });
    const student = await actAs(STUDENT);
    const personal = await student.call("student.openPersonalWorkspace");
    await student.call("student.createArtifact", {
      body: { workspaceId: personal.id, type: "document", title: "Journal", content: { kind: "text", mediaType: "text/plain", text: PRIVATE } },
    });

    // More held content than the first export would carry, as class work in a course workspace.
    const [offering] = await student.call("student.listOfferings");
    const course = await student.call("student.openCourseWorkspace", { params: { offeringId: offering!.offering.id } });
    for (const [i, bytes] of uploads.entries()) {
      await student.call("student.createArtifact", {
        body: { workspaceId: course.id, type: "image", title: `Lab photo ${i + 1}`, content: { kind: "bytes", mediaType: "image/png", base64: Buffer.from(bytes).toString("base64") } },
      });
    }

    response = await (await actAs(ADMIN)).download("admin.exportDistrict");
    const zip = await readZip(new Uint8Array(await response.arrayBuffer()), LIMITS);
    files = zip.files;
    order = [...zip.files.keys()];
    manifest = DistrictExportManifest.parse(JSON.parse(new TextDecoder().decode(files.get("manifest.json")!)));
  }, 300_000);

  it("is a streamed ZIP, saved under the district's name, whose manifest comes first and names every file in it", () => {
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="dst_[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.zip"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(order[0]).toBe("manifest.json");
    expect(manifest.format).toBe(DISTRICT_EXPORT_FORMAT);
    expect(manifest.exportedBy).toBe(ADMIN);
    expect([...files.keys()].filter((path) => path !== "manifest.json").toSorted()).toStrictEqual(manifest.files);
  });

  it("holds the directory and the work the administrator's health view counts", async () => {
    const admin = await actAs(ADMIN);
    const health = await admin.call("admin.health");
    const { counts } = manifest;
    expect({ schools: counts.schools, terms: counts.terms, offerings: counts.offerings }).toStrictEqual({
      schools: health.directory.schools, terms: health.directory.terms, offerings: health.directory.offerings,
    });
    expect(counts.submissions).toBe(health.work.submissions);
    expect(counts.assignments).toBe(health.work.installedActivities);
    expect(counts.submissions).toBeGreaterThan(0);

    const directory = read<{ principals: { id: string; kind: string }[]; enrollments: { status: string }[] }>("directory.json");
    expect(directory.principals.filter((p) => p.kind === "student")).toHaveLength(health.directory.students);
    expect(directory.principals.filter((p) => p.kind === "staff")).toHaveLength(health.directory.staff);
    expect(directory.enrollments.filter((e) => e.status === "active")).toHaveLength(health.directory.activeEnrollments);
    const authoring = await admin.call("admin.authoring");
    expect(new Set(authoring.principals.map((p) => p.id as string)).isSubsetOf(new Set(directory.principals.map((p) => p.id)))).toBe(true);
    expect(read<{ revisions: unknown[] }>("config.json").revisions).toHaveLength(counts.configRevisions);
  });

  it("carries every submitted revision, with content whose digest checks out", () => {
    const { submissions } = read<{ submissions: { items: { revisionId: string }[] }[] }>("assessment.json");
    const { revisions } = read<{ revisions: { id: string; content: { backend: string; digest: string } }[] }>("artifacts.json");
    const byId = new Map(revisions.map((r) => [r.id, r]));
    for (const item of submissions.flatMap((s) => s.items)) expect(byId.has(item.revisionId), item.revisionId).toBe(true);
    const held = revisions.filter((r) => r.content.backend === "text" || r.content.backend === "r2");
    expect(held.length).toBeGreaterThan(0);
    for (const revision of held) {
      const bytes = files.get(contentPath(revision.content.digest as never));
      expect(bytes, revision.id).toBeDefined();
      expect(`sha256:${createHash("sha256").update(bytes!).digest("hex")}`).toBe(revision.content.digest);
    }
  });

  it("carries a class's modules and assignments as its teacher sees them", async () => {
    const teacher = await actAs(G1_READING.teacherId);
    const params = { offeringId: G1_READING.offeringId };
    const { outline } = await teacher.call("teacher.listModules", { params });
    expect(read(`offerings/${G1_READING.offeringId}/course-content.json`)).toStrictEqual(outline);
    const assignments = await teacher.call("teacher.listAssignments", { params });
    const exportedAssignments = read<{ assignments: { offeringId: string }[] }>("assessment.json").assignments.filter((a) => a.offeringId === G1_READING.offeringId);
    expect(exportedAssignments).toHaveLength(assignments.length);
  });

  it("leaves personal workspaces out", () => {
    const text = [...files.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
    expect(text).not.toContain(PRIVATE);
    expect(read<{ workspaces: { kind: string }[] }>("workspaces.json").workspaces.every((w) => w.kind === "course")).toBe(true);
  });

  it("carries more held content than the first export's 32 MiB cap, every file whole", () => {
    const held = [...files].filter(([path]) => path.startsWith("content/"));
    expect(held.reduce((n, [, bytes]) => n + bytes.byteLength, 0)).toBeGreaterThan(OLD_CAP);
    // Compared by digest: element-wise equality of megabytes is slower than the test's budget.
    const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    for (const bytes of uploads) {
      const archived = files.get(contentPath(sha256(bytes) as never));
      expect(archived?.byteLength).toBe(bytes.byteLength);
      expect(sha256(archived!)).toBe(sha256(bytes));
    }
  });

  it("carries the Content Studio, activities, rubric releases, course library and marketplace packs, and no longer lists them as left out", () => {
    const { counts } = manifest;
    const studio = read<{ items: unknown[]; releases: unknown[]; bindings: unknown[] }>("content-studio.json");
    expect([studio.items.length, studio.releases.length]).toStrictEqual([counts.studioItems, counts.studioReleases]);
    expect(counts.studioReleases).toBeGreaterThan(0);
    const activities = read<{ definitions: { id: string }[]; installations: { definitionId: string }[] }>("activities.json");
    expect([activities.definitions.length, activities.installations.length]).toStrictEqual([counts.activityDefinitions, counts.activityInstallations]);
    expect(counts.activityInstallations).toBeGreaterThan(0);
    for (const installation of activities.installations) expect(activities.definitions.map((d) => d.id)).toContain(installation.definitionId);
    expect(read<{ releases: unknown[] }>("rubrics.json").releases).toHaveLength(counts.rubricReleases);
    expect(read<{ courses: unknown[] }>("course-library.json").courses).toHaveLength(counts.libraryCourses);
    expect(read<{ packs: unknown[] }>("marketplace-packs.json").packs).toHaveLength(counts.marketplacePacks);
    const excluded = manifest.excluded.join("\n");
    for (const gone of ["Content Studio items", "activity definitions", "rubric releases", "marketplace packs", "weekly notes"]) expect(excluded).not.toContain(gone);
  });

  it("is refused to teachers and students, and is read with download, not call", async () => {
    for (const id of [G1_READING.teacherId, STUDENT]) {
      const error = await (await actAs(id)).download("admin.exportDistrict").catch((e: unknown) => e);
      expect(error, id).toBeInstanceOf(DistrictApiError);
      expect(error, id).toMatchObject({ status: 403 });
    }
    await expect((await actAs(ADMIN)).call("admin.exportDistrict")).rejects.toThrow(TypeError);
  });
});
