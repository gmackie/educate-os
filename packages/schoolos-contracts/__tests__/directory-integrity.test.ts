import { describe, expect, it } from "vitest";
import { DistrictDirectorySnapshot, checkDirectoryIntegrity } from "../src/index.ts";

const D = "dst_one";
const IDP = "https://idp.one.example";

function snapshot(edit: (s: Record<string, any>) => void = () => {}) {
  const input: Record<string, any> = {
    district: { id: D, name: "One", timeZone: "UTC", trustedIssuers: [IDP] },
    schools: [{ id: "sch_a", districtId: D, name: "A", gradeBands: ["9-12"] }],
    terms: [{ id: "trm_t", districtId: D, name: "T", startsOn: "2026-09-01", endsOn: "2027-01-31", state: "active" }],
    courses: [{ id: "crs_bio", districtId: D, title: "Biology", subject: "science", gradeBand: "9" }],
    offerings: [{ id: "off_1", districtId: D, schoolId: "sch_a", termId: "trm_t", courseId: "crs_bio", sectionName: "1" }],
    principals: [
      { id: "prn_t", districtId: D, kind: "staff", status: "active", displayName: "T", externalIdentities: [{ districtId: D, issuer: IDP, subject: "t" }] },
      { id: "prn_s", districtId: D, kind: "student", status: "active", displayName: "S", externalIdentities: [{ districtId: D, issuer: IDP, subject: "s" }] },
    ],
    enrollments: [
      { id: "enr_1", districtId: D, offeringId: "off_1", principalId: "prn_t", role: "teacher", status: "active" },
      { id: "enr_2", districtId: D, offeringId: "off_1", principalId: "prn_s", role: "student", status: "active" },
    ],
    roleAssignments: [
      { principalId: "prn_t", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_a", offeringId: "off_1" }, source: "roster" },
    ],
  };
  edit(input);
  return DistrictDirectorySnapshot.parse(input);
}

const messages = (s: ReturnType<typeof snapshot>) => checkDirectoryIntegrity(s).map((i) => `${i.path}: ${i.message}`);

describe("checkDirectoryIntegrity", () => {
  it("accepts a consistent snapshot", () => {
    expect(messages(snapshot())).toEqual([]);
  });

  it("rejects records from another district", () => {
    expect(messages(snapshot((s) => { s.schools.push({ id: "sch_b", districtId: "dst_two", name: "B", gradeBands: ["K"] }); })))
      .toEqual(["schools[1].districtId: belongs to dst_two, not dst_one"]);
  });

  it("rejects dangling references", () => {
    expect(messages(snapshot((s) => { s.enrollments[1].offeringId = "off_gone"; })))
      .toEqual(["enrollments[1].offeringId: refers to unknown offering off_gone"]);
  });

  it("rejects identities from an untrusted issuer", () => {
    expect(messages(snapshot((s) => { s.principals[1].externalIdentities[0].issuer = "https://evil.example"; })))
      .toEqual(["principals[1].externalIdentities[0]: issuer https://evil.example is not trusted by dst_one"]);
  });

  it("rejects two principals claiming the same identity link", () => {
    expect(messages(snapshot((s) => { s.principals[1].externalIdentities[0].subject = "t"; })))
      .toEqual(["principals[1].externalIdentities[0]: identity is already linked to prn_t"]);
  });

  it("allows two principals to share an email, since email is not an identity", () => {
    expect(messages(snapshot((s) => {
      s.principals[0].email = "family@one.example";
      s.principals[1].email = "family@one.example";
    }))).toEqual([]);
  });

  it("rejects a staff member enrolled as a student and vice versa", () => {
    expect(messages(snapshot((s) => { s.enrollments[0].role = "student"; s.enrollments[1].role = "teacher"; }))).toEqual([
      "enrollments[0].role: a staff principal cannot enroll as student",
      "enrollments[1].role: a student principal cannot enroll as teacher",
    ]);
  });

  it("rejects a role scoped to an offering in a different school", () => {
    expect(messages(snapshot((s) => {
      s.schools.push({ id: "sch_b", districtId: D, name: "B", gradeBands: ["K"] });
      s.roleAssignments[0].scope.schoolId = "sch_b";
    }))).toEqual(["roleAssignments[0].scope.offeringId: offering off_1 is not in school sch_b"]);
  });

  it("rejects duplicate IDs", () => {
    expect(messages(snapshot((s) => { s.enrollments[1].id = "enr_1"; })))
      .toEqual(["enrollments[1].id: duplicate ID enr_1"]);
  });
});
