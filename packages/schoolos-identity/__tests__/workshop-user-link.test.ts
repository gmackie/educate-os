import { describe, expect, it } from "vitest";
import { SchoolOsError, type PrincipalId } from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { confirmWorkshopUserLink, createWorkshopUserResolver, type WorkshopUserLink } from "../src/index.ts";
import { AT, NF_ADMIN, RB_ADMIN } from "./helpers.ts";

const MORGAN = "prn_nf-morgan-lee" as PrincipalId;
const AMARA = "prn_nf-student-amara" as PrincipalId;
/** Morgan's Workshop user key: the address both districts' Morgan Lee share. */
const MORGAN_KEY = "morgan.lee@teachers.example";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(SchoolOsError);
    return (err as SchoolOsError).code;
  }
  throw new Error("expected a SchoolOsError");
}

function link(workshopUser: string, principalId: PrincipalId): WorkshopUserLink {
  return confirmWorkshopUserLink(NORTHFIELD, [], { workshopUser, principalId, confirmedBy: NF_ADMIN, confirmedAt: AT });
}

describe("Workshop user links", () => {
  it("resolves a Workshop user only through a confirmed link, never by the principal's email", () => {
    const links = [link(MORGAN_KEY, MORGAN)];
    expect(createWorkshopUserResolver(NORTHFIELD, links).resolve(MORGAN_KEY)).toEqual({ districtId: "dst_northfield", principalId: MORGAN, kind: "staff" });
    // Sam Rivera's directory email is not linked to anyone, so it resolves to no one.
    expect(codeOf(() => createWorkshopUserResolver(NORTHFIELD, links).resolve("sam.rivera@northfield.example"))).toBe("unauthenticated");
    expect(codeOf(() => createWorkshopUserResolver(NORTHFIELD, []).resolve(MORGAN_KEY))).toBe("unauthenticated");
  });

  it("keeps districts apart: another district's link resolves to nothing here", () => {
    const riverbend = confirmWorkshopUserLink(RIVERBEND, [], {
      workshopUser: MORGAN_KEY, principalId: "prn_rb-morgan-lee" as PrincipalId, confirmedBy: RB_ADMIN, confirmedAt: AT,
    });
    expect(codeOf(() => createWorkshopUserResolver(NORTHFIELD, [riverbend]).resolve(MORGAN_KEY))).toBe("unauthenticated");
    expect(createWorkshopUserResolver(RIVERBEND, [riverbend]).resolve(MORGAN_KEY).principalId).toBe("prn_rb-morgan-lee");
  });

  it("fails closed for a Workshop user with two links, or a link to a principal no longer in the directory", () => {
    const twice = [link(MORGAN_KEY, MORGAN), link(MORGAN_KEY, AMARA)];
    expect(codeOf(() => createWorkshopUserResolver(NORTHFIELD, twice).resolve(MORGAN_KEY))).toBe("unauthenticated");
    const departed = { ...NORTHFIELD, principals: NORTHFIELD.principals.filter((p) => p.id !== MORGAN), enrollments: NORTHFIELD.enrollments.filter((e) => e.principalId !== MORGAN), roleAssignments: NORTHFIELD.roleAssignments.filter((a) => a.principalId !== MORGAN) };
    expect(codeOf(() => createWorkshopUserResolver(departed, [link(MORGAN_KEY, MORGAN)]).resolve(MORGAN_KEY))).toBe("unauthenticated");
  });

  it("is confirmed only by a district administrator, once per Workshop user and principal", () => {
    const confirm = (request: Partial<Parameters<typeof confirmWorkshopUserLink>[2]>, existing: WorkshopUserLink[] = []) =>
      codeOf(() => confirmWorkshopUserLink(NORTHFIELD, existing, { workshopUser: MORGAN_KEY, principalId: MORGAN, confirmedBy: NF_ADMIN, confirmedAt: AT, ...request }));
    expect(confirm({ confirmedBy: MORGAN })).toBe("forbidden");
    expect(confirm({ confirmedBy: RB_ADMIN })).toBe("forbidden");
    expect(confirm({ principalId: "prn_rb-morgan-lee" as PrincipalId })).toBe("not-found");
    expect(confirm({}, [link(MORGAN_KEY, AMARA)])).toBe("conflict");
    expect(confirm({ workshopUser: "other-key" }, [link(MORGAN_KEY, MORGAN)])).toBe("conflict");
    expect(confirm({ workshopUser: "has space" })).toBe("validation-failed");
  });
});
