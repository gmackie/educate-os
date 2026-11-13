// SCHO-364: a district administrator exports the whole seeded Northfield showcase through the
// district API, and the archive is checked for completeness against what the API's own views say:
// directory and work counts, every submitted revision with its content, a class's modules and
// assignments. A student's personal workspace stays out, and nobody but the administrator gets it.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDistrictApiClient, type DistrictApiClient } from "@educateos/api-client";
import type { PrincipalId } from "@educateos/contracts";
import { contentPath, DISTRICT_EXPORT_FORMAT, DistrictExportManifest, type DistrictExportBody } from "@educateos/district-app";
import { NORTHFIELD, NORTHFIELD_GUARDIANS, NORTHFIELD_SHOWCASE } from "@educateos/fixtures";
import { readZip } from "@educateos/zip";
import { bootDistrictApp, bootHarness, seedShowcase, showcaseResourceUrl } from "../src/index.ts";

const ADMIN = "prn_nf-district-admin" as PrincipalId;
const STUDENT = "prn_nf-student-amara" as PrincipalId;
const G1_READING = NORTHFIELD_SHOWCASE.courses.find((course) => course.offeringId === "off_nf-g1read-fall-r7")!;
const name = (id: string) => NORTHFIELD.principals.find((p) => p.id === id)!.displayName;
const LIMITS = { maxEntries: 10_000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxCompressionRatio: 1_000 };
const PRIVATE = "PRIVATE-JOURNAL-SCHO-364";

describe("the whole-district export, over the seeded Northfield showcase", () => {
  let actAs: (id: string) => Promise<DistrictApiClient>;
  let exported: DistrictExportBody;
  let files: ReadonlyMap<string, Uint8Array>;
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

    exported = await (await actAs(ADMIN)).call("admin.exportDistrict");
    files = (await readZip(Uint8Array.from(atob(exported.base64), (c) => c.charCodeAt(0)), LIMITS)).files;
  }, 180_000);

  it("is a ZIP whose manifest names every file in it", () => {
    expect(exported.mediaType).toBe("application/zip");
    const manifest = DistrictExportManifest.parse(read("manifest.json"));
    expect(manifest).toStrictEqual(exported.manifest);
    expect(manifest.format).toBe(DISTRICT_EXPORT_FORMAT);
    expect(manifest.exportedBy).toBe(ADMIN);
    expect([...files.keys()].filter((path) => path !== "manifest.json").toSorted()).toStrictEqual(manifest.files);
  });

  it("holds the directory and the work the administrator's health view counts", async () => {
    const admin = await actAs(ADMIN);
    const health = await admin.call("admin.health");
    const { counts } = exported.manifest;
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

  it("is refused to teachers and students", async () => {
    for (const id of [G1_READING.teacherId, STUDENT]) {
      const error = await (await actAs(id)).call("admin.exportDistrict").catch((e: unknown) => e);
      expect(error, id).toMatchObject({ status: 403 });
    }
  });
});
