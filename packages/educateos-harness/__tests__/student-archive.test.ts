// SCHO-371: a student takes their own `.educateos` archive from the district API, over the seeded
// Northfield showcase. The archive validates, holds their personal work and every submission of
// theirs the district holds, withholds secret-shaped work, names nobody by district ID, and carries
// no classmate's work. Only students reach the route, and only ever for themselves.
import { beforeAll, describe, expect, it } from "vitest";
import { createDistrictApiClient, type DistrictApiClient } from "@educateos/api-client";
import type { PrincipalId } from "@educateos/contracts";
import { STUDENT_ARCHIVE_MEDIA_TYPE, type StudentArchiveBody } from "@educateos/district-app";
import { NORTHFIELD, NORTHFIELD_GUARDIANS, NORTHFIELD_SHOWCASE } from "@educateos/fixtures";
import { readZip, validateArchive, type ValidatedArchive } from "@educateos/portability";
import { bootDistrictApp, bootHarness, seedShowcase, showcaseResourceUrl } from "../src/index.ts";

const ADMIN = "prn_nf-district-admin" as PrincipalId;
const STUDENT = "prn_nf-student-amara" as PrincipalId;
const CLASSMATE = "prn_nf-student-elena" as PrincipalId;
const TEACHER = NORTHFIELD_SHOWCASE.courses[0]!.teacherId;
const name = (id: string) => NORTHFIELD.principals.find((p) => p.id === id)!.displayName;
const OWN = "OWN-JOURNAL-SCHO-371";
const PEER = "PEER-JOURNAL-SCHO-371";
const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

describe("a student's archive, over the seeded Northfield showcase", () => {
  let actAs: (id: string) => Promise<DistrictApiClient>;
  let exported: StudentArchiveBody;
  let archive: ValidatedArchive;
  let text: string;

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
    const write = async (id: string, title: string, body: string) => {
      const client = await actAs(id);
      const personal = await client.call("student.openPersonalWorkspace");
      await client.call("student.createArtifact", { body: { workspaceId: personal.id, type: "document", title, content: { kind: "text", mediaType: "text/plain", text: body } } });
    };
    await write(STUDENT, "Journal", OWN);
    await write(STUDENT, "Club notes", "club login: api_key = sk-proj-EXAMPLEEXAMPLEEXAMPLEEXAMPLE1234");
    await write(CLASSMATE, "Journal", PEER);

    exported = await (await actAs(STUDENT)).call("student.exportArchive");
    archive = await validateArchive(decode(exported.base64));
    text = (await readZip(decode(exported.base64))).map((file) => new TextDecoder().decode(file.bytes)).join("\n");
  }, 180_000);

  it("is a valid .educateos archive whose manifest the response repeats", () => {
    expect(exported.mediaType).toBe(STUDENT_ARCHIVE_MEDIA_TYPE);
    expect(exported.fileName).toMatch(/^educateos-archive-\d{4}-\d{2}-\d{2}\.educateos$/);
    expect(archive.manifest).toStrictEqual(exported.manifest);
    expect(archive.manifest.district.displayName).toBe(NORTHFIELD.district.name);
  });

  it("holds the student's personal work and every live submission of theirs the district holds", async () => {
    expect(archive.artifacts.some((a) => a.context.kind === "personal" && a.title === "Journal")).toBe(true);
    expect(text).toContain(OWN);
    const district = await (await actAs(ADMIN)).call("admin.exportDistrict");
    const files = (await readZip(decode(district.base64))).filter((entry) => entry.path === "assessment.json");
    const { submissions } = JSON.parse(new TextDecoder().decode(files[0]!.bytes)) as { submissions: { studentPrincipalId: string; withdrawnAt?: string }[] };
    const own = submissions.filter((s) => s.studentPrincipalId === STUDENT && s.withdrawnAt === undefined);
    expect(own.length).toBeGreaterThan(0);
    expect(archive.submissions).toHaveLength(own.length);
  });

  it("withholds secret-shaped work and says so", () => {
    expect(exported.withheld).toStrictEqual([{ kind: "artifact", label: "Club notes", found: expect.any(Array) }]);
    expect(text).not.toContain("sk-proj-");
  });

  it("carries no classmate's work and no district IDs", () => {
    expect(text).not.toContain(PEER);
    for (const id of ["prn_", "wsp_", "art_", "sub_", "off_", NORTHFIELD.district.id]) expect(text, id).not.toContain(id);
  });

  it("is refused to staff, who are not students", async () => {
    for (const id of [TEACHER, ADMIN]) {
      const error = await (await actAs(id)).call("student.exportArchive").catch((e: unknown) => e);
      expect(error, id).toMatchObject({ status: 403 });
    }
  });
});
