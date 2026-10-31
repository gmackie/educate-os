// Delegations in the district application (SCHO-175): a teacher delegates to a registered client
// over the teacher API, the district's engine bounds every request the client makes for them, and
// a roster change ends it on the next decision.
import { describe, expect, it } from "vitest";
import { DelegationId, DistrictId, PrincipalId } from "@educateos/contracts";
import type { DelegationCeiling } from "@educateos/policy";
import { bootDistrict, expectError, NF, NORTHFIELD, type TestDistrict } from "./support.ts";

const CLIENT = { issuer: "https://auth.northfield.example", clientId: "lesson-planner" };
const offering = (offeringId: string) => {
  const found = NORTHFIELD.offerings.find((o) => o.id === offeringId)!;
  return { level: "offering", districtId: found.districtId, schoolId: found.schoolId, offeringId: found.id } as const;
};
const ceiling = (offeringId: string): DelegationCeiling => ({
  scope: offering(offeringId),
  actions: ["read", "list"],
  kinds: ["rubric", "submission"],
  classifications: ["course"],
});

/** A read of an offering's unowned course rubric, as `principalId` acting under `delegationId`. */
function readRubric(district: TestDistrict, principalId: string, offeringId: string, delegationId?: string) {
  return district.app.engine.decide({
    subject: {
      principalId: PrincipalId.parse(principalId),
      districtId: DistrictId.parse(NORTHFIELD.district.id),
      ...(delegationId === undefined ? {} : { delegationId: DelegationId.parse(delegationId) }),
    },
    action: "read",
    resource: { kind: "rubric", scope: offering(offeringId), classification: "course" },
    context: { channel: "mcp-tool", termState: "active" },
  });
}

describe("delegations in the district application", () => {
  it("are issued by a teacher for her own class only, and listed and revoked by her or a district admin", async () => {
    const district = await bootDistrict();
    const morgan = district.tokenFor(NF.morgan);
    const delegation = await district.ok(morgan, "teacher.issueDelegation", { body: { client: CLIENT, ceiling: ceiling(NF.bio), durationHours: 24 } });
    expect(delegation).toMatchObject({ grantorPrincipalId: NF.morgan, client: CLIENT });
    expectError(await district.call(morgan, "teacher.issueDelegation", { body: { client: CLIENT, ceiling: ceiling(NF.eng9), durationHours: 24 } }), 403, "forbidden");

    expect((await district.ok(morgan, "teacher.listDelegations")).map((d) => d.id)).toEqual([delegation.id]);
    expect(await district.ok(district.tokenFor(NF.rivera), "teacher.listDelegations")).toEqual([]);
    expectError(await district.call(district.tokenFor(NF.rivera), "teacher.revokeDelegation", { params: { delegationId: delegation.id }, body: {} }), 404, "not-found");
    const revoked = await district.ok(district.tokenFor(NF.admin), "teacher.revokeDelegation", { params: { delegationId: delegation.id }, body: {} });
    expect(revoked.revoked?.by).toBe(NF.admin);
  });

  it("bound the client to its class, and end when the teacher leaves the class's roster", async () => {
    const district = await bootDistrict();
    const delegation = await district.ok(district.tokenFor(NF.morgan), "teacher.issueDelegation", { body: { client: CLIENT, ceiling: ceiling(NF.bio), durationHours: 24 } });

    expect((await readRubric(district, NF.morgan, NF.bio, delegation.id)).decision.effect).toBe("allow");
    // Morgan teaches Biology P4 too, but her client was given P2 only.
    expect((await readRubric(district, NF.morgan, NF.bioSpring)).decision.effect).toBe("allow");
    expect((await readRubric(district, NF.morgan, NF.bioSpring, delegation.id)).ruleId).toBe("delegation.ceiling");
    expect(district.audit.events().at(-1)).toMatchObject({ effect: "deny", delegationId: delegation.id });

    // The roster drops Morgan from P2: the unexpired delegation stops on the next decision.
    const { snapshot, version } = await district.stores.directory.load();
    const enrollments = snapshot.enrollments.map((e) => (e.offeringId === NF.bio && e.principalId === NF.morgan ? { ...e, status: "inactive" as const } : e));
    await district.stores.directory.commit({ ...snapshot, enrollments }, version);
    expect((await readRubric(district, NF.morgan, NF.bio, delegation.id)).ruleId).toBe("delegation.grantor-standing");
  });
});
