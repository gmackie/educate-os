import { describe, expect, it } from "vitest";
import {
  DistrictId,
  ExternalIdentity,
  GUARDIAN_READABLE_KINDS,
  GuardianRelationship,
  GuardianRelationshipId,
  guardianRelationshipInForce,
  ID_PREFIXES,
  InstanceId,
  OfferingId,
  Principal,
  PrincipalKind,
  ResourceId,
  RevisionId,
  RoleAssignment,
  roleAssignmentInForce,
  Scope,
  SchoolId,
  externalIdentityKey,
  scopeContains,
  SourceLink,
} from "../src/index.ts";

describe("identifiers", () => {
  it("accepts an ID of its own kind and rejects every other kind", () => {
    expect(SchoolId.safeParse("sch_north-high").success).toBe(true);
    expect(SchoolId.safeParse("off_north-high").success).toBe(false);
    expect(OfferingId.safeParse("sch_north-high").success).toBe(false);
  });

  it("rejects IDs that could be confused with paths or other encodings", () => {
    for (const bad of ["dst_", "dst_North", "dst_a/b", "dst_a b", "dst_-a", "dst_a_b"]) {
      expect(DistrictId.safeParse(bad).success, bad).toBe(false);
    }
  });
});

const identity = (issuer: string, subject: string) =>
  ExternalIdentity.parse({ districtId: "dst_one", issuer, subject });

describe("external identity keys", () => {
  it("distinguishes the same subject under different issuers", () => {
    expect(externalIdentityKey(identity("https://a.example", "42")))
      .not.toBe(externalIdentityKey(identity("https://b.example", "42")));
  });

  it("cannot be forged by moving a delimiter between issuer and subject", () => {
    expect(externalIdentityKey(identity("https://a.example/x", "y")))
      .not.toBe(externalIdentityKey(identity("https://a.example", "x/y")));
    expect(externalIdentityKey(identity("https://a.example", '","https://b.example')))
      .not.toBe(externalIdentityKey(identity("https://b.example", '","https://a.example')));
  });

  it("requires an https issuer", () => {
    expect(ExternalIdentity.safeParse({ districtId: "dst_one", issuer: "http://a.example", subject: "1" }).success)
      .toBe(false);
  });

  it("never accepts an email in place of an identity link", () => {
    const parsed = Principal.safeParse({
      id: "prn_x",
      districtId: "dst_one",
      kind: "student",
      status: "active",
      displayName: "X",
      email: "x@example.com",
      externalIdentities: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("scopeContains", () => {
  const district = Scope.parse({ level: "district", districtId: "dst_one" });
  const school = Scope.parse({ level: "school", districtId: "dst_one", schoolId: "sch_a" });
  const offering = Scope.parse({ level: "offering", districtId: "dst_one", schoolId: "sch_a", offeringId: "off_1" });
  const otherSchoolOffering = Scope.parse({ level: "offering", districtId: "dst_one", schoolId: "sch_b", offeringId: "off_1" });
  const otherDistrict = Scope.parse({ level: "district", districtId: "dst_two" });

  it("contains itself and its descendants", () => {
    expect(scopeContains(district, district)).toBe(true);
    expect(scopeContains(district, offering)).toBe(true);
    expect(scopeContains(school, offering)).toBe(true);
  });

  it("never contains its ancestors, siblings or another district", () => {
    expect(scopeContains(offering, school)).toBe(false);
    expect(scopeContains(school, otherSchoolOffering)).toBe(false);
    expect(scopeContains(district, otherDistrict)).toBe(false);
    expect(scopeContains(otherDistrict, offering)).toBe(false);
  });

  it("rejects scopes with fields from another level", () => {
    expect(Scope.safeParse({ level: "district", districtId: "dst_one", schoolId: "sch_a" }).success).toBe(false);
  });
});

describe("shared identifiers", () => {
  it("gives every record kind its own prefix, so no two kinds can parse each other's IDs", () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(InstanceId.safeParse("ins_northfield").success).toBe(true);
    expect(InstanceId.safeParse("dst_northfield").success).toBe(false);
    expect(ResourceId.safeParse("pck_bio").success).toBe(false);
    expect(RevisionId.safeParse("rev_1").success).toBe(true);
  });
});

describe("principal lifecycle", () => {
  const principal = {
    id: "prn_x",
    districtId: "dst_one",
    kind: "student",
    displayName: "X",
    externalIdentities: [{ districtId: "dst_one", issuer: "https://idp.one.example", subject: "x" }],
  };

  it("requires a status, so no principal is active by omission", () => {
    expect(Principal.safeParse(principal).success).toBe(false);
    for (const status of ["active", "inactive", "graduated"]) {
      expect(Principal.safeParse({ ...principal, status }).success, status).toBe(true);
    }
    expect(Principal.safeParse({ ...principal, status: "deleted" }).success).toBe(false);
  });

  it("keeps a source link to provenance: no identity or profile fields ride along", () => {
    const link = { system: "oneroster", sourcedId: "u-17", lastSeenAt: "2026-10-20T14:00:00Z" };
    expect(SourceLink.safeParse(link).success).toBe(true);
    expect(SourceLink.safeParse({ ...link, email: "x@one.example" }).success).toBe(false);
    expect(SourceLink.safeParse({ ...link, system: "OneRoster" }).success).toBe(false);
  });
});

describe("guardians and dated roles (ADR-0012)", () => {
  const relationship = {
    id: "grl_one",
    districtId: "dst_one",
    guardianPrincipalId: "prn_parent",
    studentPrincipalId: "prn_child",
    status: "active",
    readableKinds: ["official-grade"],
    consent: "not-required",
    validFrom: "2026-09-01T00:00:00Z",
    validUntil: "2027-06-30T00:00:00Z",
    created: { by: "prn_admin", at: "2026-08-30T00:00:00Z" },
    confirmed: { by: "prn_admin", at: "2026-08-31T00:00:00Z" },
  };
  const parsed = GuardianRelationship.parse(relationship);

  it("is a principal kind of its own, with an ID of its own", () => {
    expect(PrincipalKind.options).toContain("guardian");
    expect(GuardianRelationshipId.safeParse("grl_one").success).toBe(true);
    expect(GuardianRelationshipId.safeParse("prn_one").success).toBe(false);
  });

  it("grants only while active, in date, unsuspended and with consent not withdrawn", () => {
    expect(guardianRelationshipInForce(parsed, new Date("2026-10-01T00:00:00Z"))).toBe(true);
    expect(guardianRelationshipInForce(parsed, new Date("2026-08-31T23:59:59Z"))).toBe(false);
    expect(guardianRelationshipInForce(parsed, new Date("2027-06-30T00:00:00Z"))).toBe(false);
    const at = new Date("2026-10-01T00:00:00Z");
    expect(guardianRelationshipInForce({ ...parsed, consent: "withdrawn" }, at)).toBe(false);
    expect(guardianRelationshipInForce({ ...parsed, suspended: { ...parsed.created, reason: "court-order" } }, at)).toBe(false);
    expect(guardianRelationshipInForce({ ...parsed, status: "revoked", revoked: parsed.created }, at)).toBe(false);
  });

  it("refuses kinds a guardian may never read, and free-text suspension reasons", () => {
    for (const kind of ["submission", "artifact", "personal-workspace", "personal-conversation", "shared-conversation", "enrollment"]) {
      expect(GuardianRelationship.safeParse({ ...relationship, readableKinds: [kind] }).success, kind).toBe(false);
    }
    expect(GUARDIAN_READABLE_KINDS).toEqual(["offering", "activity", "feedback", "official-grade", "announcement"]);
    const suspended = { by: "prn_admin", at: "2026-10-01T00:00:00Z", reason: "Custody dispute with father" };
    expect(GuardianRelationship.safeParse({ ...relationship, suspended }).success).toBe(false);
  });

  it("dates a role assignment, inclusive of validFrom and exclusive of validUntil", () => {
    const role = RoleAssignment.parse({
      principalId: "prn_sub",
      role: "teacher",
      scope: { level: "district", districtId: "dst_one" },
      source: "local-grant",
      validFrom: "2026-10-01T00:00:00Z",
      validUntil: "2026-10-15T00:00:00Z",
    });
    expect(roleAssignmentInForce(role, new Date("2026-10-01T00:00:00Z"))).toBe(true);
    expect(roleAssignmentInForce(role, new Date("2026-09-30T23:59:59Z"))).toBe(false);
    expect(roleAssignmentInForce(role, new Date("2026-10-15T00:00:00Z"))).toBe(false);
    expect(roleAssignmentInForce({}, new Date())).toBe(true);
    expect(roleAssignmentInForce({ validFrom: role.validUntil, validUntil: role.validFrom }, new Date("2026-10-10T00:00:00Z"))).toBe(false);
  });
});
