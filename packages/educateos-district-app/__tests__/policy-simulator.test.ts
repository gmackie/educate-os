// The policy simulator (SCHO-175): a district admin asks what the engine would decide for any
// principal of the district, and why, and nothing is decided or recorded for that principal.
import { describe, expect, it } from "vitest";
import { bootDistrict, expectError, NF, NORTHFIELD } from "./support.ts";

const offering = (offeringId: string) => {
  const found = NORTHFIELD.offerings.find((o) => o.id === offeringId)!;
  return { level: "offering", districtId: found.districtId, schoolId: found.schoolId, offeringId } as const;
};
const grade = (offeringId: string, owner: string) => ({ kind: "official-grade", scope: offering(offeringId), classification: "course", ownerPrincipalId: owner }) as const;

describe("the policy simulator", () => {
  it("answers allow, deny or approval-required with the reason and the deciding rule", async () => {
    const district = await bootDistrict();
    const admin = district.tokenFor(NF.admin);
    const simulate = (body: object) => district.ok(admin, "admin.simulatePolicy", { body } as never);

    expect(await simulate({ principalId: NF.rivera, action: "grade", resource: grade(NF.eng9, NF.amara), channel: "http", termState: "active" }))
      .toEqual({ verdict: "allow", ruleId: "grade.official.teacher-direct" });
    // The same grade through an agent waits for a teacher.
    expect(await simulate({ principalId: NF.rivera, action: "grade", resource: grade(NF.eng9, NF.amara), channel: "agent", termState: "active" }))
      .toEqual({ verdict: "approval-required", reason: "requires-teacher-review", ruleId: "grade.official.needs-teacher-review" });
    expect(await simulate({ principalId: NF.amara, action: "grade", resource: grade(NF.eng9, NF.amara), channel: "http", termState: "active" }))
      .toMatchObject({ verdict: "deny", reason: expect.any(String), ruleId: expect.any(String) });
    // A resource in another district is refused before any rule.
    const elsewhere = { kind: "rubric", scope: { level: "district", districtId: "dst_riverbend" }, classification: "course" };
    expect(await simulate({ principalId: NF.rivera, action: "read", resource: elsewhere, channel: "http" }))
      .toEqual({ verdict: "deny", reason: "cross-district", ruleId: "precheck.cross-district" });
  });

  it("records nothing for the simulated principal, and answers district administrators only", async () => {
    const district = await bootDistrict();
    const before = district.audit.events().length;
    await district.ok(district.tokenFor(NF.admin), "admin.simulatePolicy", {
      body: { principalId: NF.rivera, action: "grade", resource: grade(NF.eng9, NF.amara), channel: "http", termState: "active" },
    } as never);
    // Only the administrator's own permission to simulate was decided and recorded.
    const recorded = district.audit.events().slice(before);
    expect(recorded.map((e) => [e.principalId, e.resourceKind])).toEqual([[NF.admin, "audit-event"]]);

    expectError(await district.call(district.tokenFor(NF.rivera), "admin.simulatePolicy", {
      body: { principalId: NF.rivera, action: "read", resource: grade(NF.eng9, NF.amara), channel: "http" },
    } as never), 403, "forbidden");
  });
});
