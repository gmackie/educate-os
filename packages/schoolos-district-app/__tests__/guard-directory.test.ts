// The AI call guard's read model (SCHO-132): who a Workshop user is, from the district's records only.

import { describe, expect, it } from "vitest";
import { DistrictDirectorySnapshot, type PrincipalId } from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { confirmWorkshopUserLink, type WorkshopUserLink } from "@schoolos/identity";
import type { Workspace } from "@schoolos/workspaces";
import { createDistrictApp, guardSubjectFrom, ledgerDirectory, inMemoryDistrictStores, type GuardDirectorySource } from "../src/index.ts";

const AT = "2026-10-20T15:00:00Z";
const NF_ADMIN = "prn_nf-district-admin" as PrincipalId;

function links(directory: DistrictDirectorySnapshot, admin: string, pairs: Record<string, string>): WorkshopUserLink[] {
  const out: WorkshopUserLink[] = [];
  for (const [workshopUser, principalId] of Object.entries(pairs)) {
    out.push(confirmWorkshopUserLink(directory, out, { workshopUser, principalId: principalId as PrincipalId, confirmedBy: admin as PrincipalId, confirmedAt: AT }));
  }
  return out;
}

const NF_LINKS = links(NORTHFIELD, NF_ADMIN, {
  "amara@northfield.example": "prn_nf-student-amara",
  "chidi@northfield.example": "prn_nf-student-chidi",
  "morgan@northfield.example": "prn_nf-morgan-lee",
  "avery@northfield.example": "prn_nf-district-admin",
  "felix@northfield.example": "prn_nf-student-felix",
});

const BIO_WORKSPACE: Workspace = {
  kind: "course",
  id: "wsp_nf-amara-bio" as Workspace["id"],
  districtId: "dst_northfield" as Workspace["districtId"],
  ownerPrincipalId: "prn_nf-student-amara" as PrincipalId,
  createdAt: AT,
  storageHandle: { backend: "workshop", ref: "gadget-amara-bio" },
  schoolId: "sch_nf-high" as Extract<Workspace, { kind: "course" }>["schoolId"],
  offeringId: "off_nf-bio-fall-p2" as Extract<Workspace, { kind: "course" }>["offeringId"],
  termId: "trm_nf-2026-fall" as Extract<Workspace, { kind: "course" }>["termId"],
};

const SOURCE: GuardDirectorySource = { directory: NORTHFIELD, workspaces: [BIO_WORKSPACE], workshopUserLinks: NF_LINKS };

describe("guardSubjectFrom", () => {
  it("maps a linked student to their principal, a course workspace by its Workshop handle, and that course's grade band", () => {
    expect(guardSubjectFrom(SOURCE, { workshopUser: "amara@northfield.example", gadgetId: "gadget-amara-bio" })).toEqual({
      principal: { principalId: "prn_nf-student-amara", districtId: "dst_northfield" },
      kind: "student",
      roles: [],
      workspace: { kind: "course", offeringId: "off_nf-bio-fall-p2" },
      gradeBands: ["9-10"],
    });
    // Outside a course workspace, a student's grade bands are those of all their active courses.
    expect(guardSubjectFrom(SOURCE, { workshopUser: "amara@northfield.example", gadgetId: "some-personal-gadget" })).toMatchObject({
      workspace: { kind: "personal" },
      gradeBands: ["9", "9-10"],
    });
    expect(guardSubjectFrom(SOURCE, { workshopUser: "chidi@northfield.example" })).toMatchObject({ gradeBands: ["7"] });
  });

  it("falls back to the student's schools, then to no band at all", () => {
    const dropped = { ...NORTHFIELD, enrollments: NORTHFIELD.enrollments.map((e) => (e.principalId === "prn_nf-student-felix" ? { ...e, status: "inactive" as const } : e)) };
    expect(guardSubjectFrom({ ...SOURCE, directory: dropped }, { workshopUser: "felix@northfield.example" })).toMatchObject({ gradeBands: ["6-8"] });
    const nowhere = { ...NORTHFIELD, enrollments: NORTHFIELD.enrollments.filter((e) => e.principalId !== "prn_nf-student-felix") };
    expect(guardSubjectFrom({ ...SOURCE, directory: nowhere }, { workshopUser: "felix@northfield.example" })).toMatchObject({ gradeBands: [] });
  });

  it("reports staff with their roles and no grade band", () => {
    expect(guardSubjectFrom(SOURCE, { workshopUser: "morgan@northfield.example" })).toEqual({
      principal: { principalId: "prn_nf-morgan-lee", districtId: "dst_northfield" },
      kind: "staff",
      roles: ["teacher"],
      workspace: { kind: "personal" },
      gradeBands: [],
    });
    expect(guardSubjectFrom(SOURCE, { workshopUser: "avery@northfield.example" })).toMatchObject({ kind: "staff", roles: ["district-admin"] });
  });

  it("knows no one by their directory email, and no one another district linked", () => {
    expect(guardSubjectFrom(SOURCE, { workshopUser: "sam.rivera@northfield.example" })).toBeNull();
    const riverbend = links(RIVERBEND, "prn_rb-district-admin", { "morgan.lee@teachers.example": "prn_rb-morgan-lee" });
    expect(guardSubjectFrom({ ...SOURCE, workshopUserLinks: [...NF_LINKS, ...riverbend] }, { workshopUser: "morgan.lee@teachers.example" })).toBeNull();
  });

  it("has no subject for a principal that is not active, whose grants ended with its status", () => {
    for (const status of ["inactive", "graduated"] as const) {
      const directory = { ...NORTHFIELD, principals: NORTHFIELD.principals.map((p) => (p.id === "prn_nf-student-amara" ? { ...p, status } : p)) };
      expect(guardSubjectFrom({ ...SOURCE, directory }, { workshopUser: "amara@northfield.example", gadgetId: "gadget-amara-bio" })).toBeNull();
    }
  });

  it("refuses a gadget whose workspace belongs to someone else", () => {
    expect(guardSubjectFrom(SOURCE, { workshopUser: "chidi@northfield.example", gadgetId: "gadget-amara-bio" })).toBeNull();
  });
});

describe("ledgerDirectory", () => {
  it("keeps what funding is decided by and drops every principal's profile", () => {
    const redacted = ledgerDirectory(NORTHFIELD);
    expect(redacted.enrollments).toEqual(NORTHFIELD.enrollments);
    expect(redacted.principals.map((p) => [p.id, p.kind, p.status])).toEqual(NORTHFIELD.principals.map((p) => [p.id, p.kind, p.status]));
    expect(DistrictDirectorySnapshot.safeParse(redacted).success).toBe(true);
    expect(JSON.stringify(redacted)).not.toMatch(/@|Okafor|Morgan Lee/);
  });
});

describe("DistrictApp.guardDirectory", () => {
  it("reads the district's stores afresh, so a newly confirmed link takes effect at once", async () => {
    const stores = inMemoryDistrictStores(NORTHFIELD);
    const app = await createDistrictApp({ stores, verifyRequest: async () => undefined, importFetch: async () => new Response(null, { status: 404 }) });
    expect(await app.guardDirectory.guardSubject({ workshopUser: "amara@northfield.example" })).toBeNull();
    await stores.workshopUserLinks.add(NF_LINKS[0]!);
    expect(await app.guardDirectory.guardSubject({ workshopUser: "amara@northfield.example" })).toMatchObject({
      principal: { principalId: "prn_nf-student-amara" },
      kind: "student",
    });
  });
});
