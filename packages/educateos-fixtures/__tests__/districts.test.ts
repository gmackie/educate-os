import { describe, expect, it } from "vitest";
import { checkDirectoryIntegrity, externalIdentityKey } from "@educateos/contracts";
import {
  CEDARVALLEY,
  DEMO_DISTRICTS,
  HARBOR,
  LAKESHORE,
  NORTHFIELD,
  PRAIRIE,
  RIVERBEND,
  SYNTHETIC_DISTRICTS,
} from "../src/index.ts";

type Snapshot = (typeof SYNTHETIC_DISTRICTS)[number];

function allIds(snapshot: Snapshot): string[] {
  return [
    snapshot.district.id,
    ...[snapshot.schools, snapshot.terms, snapshot.courses, snapshot.offerings, snapshot.principals, snapshot.enrollments]
      .flatMap((records) => records.map((r) => r.id)),
  ];
}

function identityKeys(snapshot: Snapshot): string[] {
  return snapshot.principals.flatMap((p) => p.externalIdentities.map(externalIdentityKey));
}

const principal = (snapshot: Snapshot, id: string) => snapshot.principals.find((p) => p.id === id)!;

describe.each(DEMO_DISTRICTS.map((d) => [d.slug, d] as const))("%s", (_, demo) => {
  const district = demo.directory;

  it("is internally consistent", () => {
    expect(checkDirectoryIntegrity(district)).toEqual([]);
  });

  it("is large enough for the pilot scenarios", () => {
    expect(district.schools.length).toBeGreaterThanOrEqual(2);
    expect(district.principals.filter((p) => p.kind === "student").length).toBeGreaterThanOrEqual(2);
    const subjects = new Set(
      district.offerings.map((o) => district.courses.find((c) => c.id === o.courseId)!.subject),
    );
    for (const subject of ["science", "english-language-arts", "history-social-studies"] as const) {
      expect(subjects, subject).toContain(subject);
    }
    expect(subjects.has("mathematics") || subjects.has("arts")).toBe(true);
  });

  it("has a district admin, which the harness seeds demo content as", () => {
    expect(district.roleAssignments.some((r) => r.role === "district-admin")).toBe(true);
  });

  it("uses only reserved example domains, so no fixture can reach a real person", () => {
    for (const principal of district.principals) {
      if (principal.email !== undefined) expect(principal.email).toMatch(/@[a-z.]+\.example$/);
    }
    // Google sign-in has one issuer for every Workspace domain; its subjects here are synthetic.
    const google = demo.profile.sso === "google" ? ["https://accounts.google.com"] : [];
    for (const issuer of district.district.trustedIssuers) {
      if (!google.includes(issuer)) expect(issuer).toMatch(/^https:\/\/[a-z.]+\.example$/);
    }
  });

  it("links each guardian relationship to its own guardian and student principals", () => {
    for (const relationship of demo.guardians) {
      expect(relationship.districtId).toBe(district.district.id);
      expect(principal(district, relationship.guardianPrincipalId).kind).toBe("guardian");
      expect(principal(district, relationship.studentPrincipalId).kind).toBe("student");
    }
  });
});

describe("the six districts", () => {
  it("have the integration profiles of the SCHO-198 plan, on harness ports 4801 to 4806", () => {
    expect(DEMO_DISTRICTS.map((d) => [d.slug, d.harnessPort, d.profile])).toEqual([
      ["northfield", 4801, { sso: "district-oidc", roster: "oneroster-csv", lms: "canvas-lti", gradeAuthority: "canvas" }],
      ["riverbend", 4802, { sso: "district-oidc", roster: "oneroster-rest", lms: "lms-lite", gradeAuthority: "educateos" }],
      ["prairie", 4803, { sso: "local", roster: "local", lms: "lms-lite", gradeAuthority: "educateos" }],
      ["cedarvalley", 4804, { sso: "clever", roster: "clever", lms: "google-classroom", gradeAuthority: "google-classroom" }],
      ["lakeshore", 4805, { sso: "classlink", roster: "oneroster-rest", lms: "schoology-lti", gradeAuthority: "schoology" }],
      ["harbor", 4806, { sso: "google", roster: "google-classroom", lms: "google-classroom", gradeAuthority: "google-classroom" }],
    ]);
    expect(SYNTHETIC_DISTRICTS).toEqual(DEMO_DISTRICTS.map((d) => d.directory));
  });

  it("share no ID, issuer or identity link", () => {
    for (const [i, a] of SYNTHETIC_DISTRICTS.entries()) {
      for (const b of SYNTHETIC_DISTRICTS.slice(i + 1)) {
        const pair = `${a.district.id} / ${b.district.id}`;
        const ids = new Set(allIds(a));
        expect(allIds(b).filter((id) => ids.has(id)), pair).toEqual([]);
        const issuers = new Set(a.district.trustedIssuers);
        expect(b.district.trustedIssuers.filter((x) => issuers.has(x)), pair).toEqual([]);
        const keys = new Set(identityKeys(a));
        expect(identityKeys(b).filter((k) => keys.has(k)), pair).toEqual([]);
      }
    }
  });

  it("include one teacher whose email and subject collide across districts, as distinct principals", () => {
    const nf = principal(NORTHFIELD, "prn_nf-morgan-lee");
    const rb = principal(RIVERBEND, "prn_rb-morgan-lee");
    expect(nf.email).toBe(rb.email);
    expect(nf.externalIdentities[0]!.subject).toBe(rb.externalIdentities[0]!.subject);
    expect(externalIdentityKey(nf.externalIdentities[0]!)).not.toBe(externalIdentityKey(rb.externalIdentities[0]!));
  });

  it("include two different students who share an IdP subject under different issuers", () => {
    const cv = principal(CEDARVALLEY, "prn_cv-student-rowan");
    const ls = principal(LAKESHORE, "prn_ls-student-sky");
    expect(cv.externalIdentities[0]!.subject).toBe(ls.externalIdentities[0]!.subject);
    expect(cv.displayName).not.toBe(ls.displayName);
    expect(externalIdentityKey(cv.externalIdentities[0]!)).not.toBe(externalIdentityKey(ls.externalIdentities[0]!));
  });

  it("keep a dropped student's enrollment as inactive rather than deleting it", () => {
    expect(NORTHFIELD.enrollments.find((e) => e.id === "enr_nf-10")?.status).toBe("inactive");
    for (const snapshot of [CEDARVALLEY, LAKESHORE, HARBOR]) {
      const dropped = snapshot.enrollments.filter((e) => e.role === "student" && e.status === "inactive");
      expect(dropped, snapshot.district.id).toHaveLength(1);
      // Dropped from one class mid-term, the student stays active in the district.
      expect(principal(snapshot, dropped[0]!.principalId).status).toBe("active");
    }
  });

  it("include siblings who share a family email address with their guardian", () => {
    for (const [snapshot, email] of [[PRAIRIE, "family.hollis@prairie.example"], [CEDARVALLEY, "family.nguyen@cedarvalley.example"]] as const) {
      const sharing = snapshot.principals.filter((p) => p.email === email);
      expect(sharing.map((p) => p.kind).toSorted(), snapshot.district.id).toEqual(["guardian", "student", "student"]);
    }
  });

  it("include a teacher who teaches at two schools", () => {
    const offerings = CEDARVALLEY.enrollments
      .filter((e) => e.principalId === "prn_cv-teacher-whitaker" && e.role === "teacher")
      .map((e) => CEDARVALLEY.offerings.find((o) => o.id === e.offeringId)!.schoolId);
    expect(new Set(offerings)).toEqual(new Set(["sch_cv-middle", "sch_cv-high"]));
  });

  it("include a guardian relationship that is still pending, which grants nothing", () => {
    expect(DEMO_DISTRICTS.flatMap((d) => d.guardians).filter((g) => g.status === "pending").map((g) => g.id)).toEqual(["grl_hb-fontaine-nia"]);
  });
});
