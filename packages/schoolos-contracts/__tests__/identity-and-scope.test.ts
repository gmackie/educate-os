import { describe, expect, it } from "vitest";
import {
  DistrictId,
  ExternalIdentity,
  OfferingId,
  Principal,
  Scope,
  SchoolId,
  externalIdentityKey,
  scopeContains,
} from "../src/index";

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
