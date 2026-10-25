import { describe, expect, it } from "vitest";
import { checkDirectoryIntegrity, externalIdentityKey } from "@educateos/contracts";
import { NORTHFIELD, RIVERBEND, SYNTHETIC_DISTRICTS } from "../src/index.ts";

function allIds(snapshot: (typeof SYNTHETIC_DISTRICTS)[number]): string[] {
  return [
    snapshot.district.id,
    ...[snapshot.schools, snapshot.terms, snapshot.courses, snapshot.offerings, snapshot.principals, snapshot.enrollments]
      .flatMap((records) => records.map((r) => r.id)),
  ];
}

function identityKeys(snapshot: (typeof SYNTHETIC_DISTRICTS)[number]): string[] {
  return snapshot.principals.flatMap((p) => p.externalIdentities.map(externalIdentityKey));
}

describe.each(SYNTHETIC_DISTRICTS.map((d) => [d.district.id, d] as const))("%s", (_, district) => {
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

  it("uses only reserved example domains, so no fixture can reach a real person", () => {
    for (const principal of district.principals) {
      if (principal.email !== undefined) expect(principal.email).toMatch(/@[a-z.]+\.example$/);
    }
    for (const issuer of district.district.trustedIssuers) expect(issuer).toMatch(/^https:\/\/[a-z.]+\.example$/);
  });
});

describe("the two districts", () => {
  it("share no ID, issuer or identity link", () => {
    const nfIds = new Set(allIds(NORTHFIELD));
    expect(allIds(RIVERBEND).filter((id) => nfIds.has(id))).toEqual([]);

    const nfIssuers = new Set(NORTHFIELD.district.trustedIssuers);
    expect(RIVERBEND.district.trustedIssuers.filter((i) => nfIssuers.has(i))).toEqual([]);

    const nfKeys = new Set(identityKeys(NORTHFIELD));
    expect(identityKeys(RIVERBEND).filter((k) => nfKeys.has(k))).toEqual([]);
  });

  it("include one teacher whose email and subject collide across districts, as distinct principals", () => {
    const nf = NORTHFIELD.principals.find((p) => p.id === "prn_nf-morgan-lee")!;
    const rb = RIVERBEND.principals.find((p) => p.id === "prn_rb-morgan-lee")!;
    expect(nf.email).toBe(rb.email);
    expect(nf.externalIdentities[0]!.subject).toBe(rb.externalIdentities[0]!.subject);
    expect(externalIdentityKey(nf.externalIdentities[0]!)).not.toBe(externalIdentityKey(rb.externalIdentities[0]!));
  });

  it("keep a dropped student's enrollment as inactive rather than deleting it", () => {
    expect(NORTHFIELD.enrollments.find((e) => e.id === "enr_nf-10")?.status).toBe("inactive");
  });
});
