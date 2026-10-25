// The broker's district wiring (SCHO-60): principals resolved from the directory as it is now, and
// deep link choices authorized by the policy engine.
import { describe, expect, it } from "vitest";
import type { DistrictDirectorySnapshot } from "@educateos/contracts";
import type { ResolvedLaunch } from "@educateos/lti";
import { districtPrincipalResolver, policySelectActivities } from "../src/index.ts";
import { AMARA, BIO, CELL_LAB, createDistrict, ESSAY, MORGAN, NF, NF_CANVAS, rejection, SUBJECTS } from "./setup.ts";

const launchAs = (principalId: string, kind: "student" | "staff"): ResolvedLaunch => ({
  principal: { districtId: NF, principalId: principalId as never, kind, identity: { districtId: NF, issuer: NF_CANVAS, subject: SUBJECTS[principalId]! } },
  offeringId: BIO,
  messageType: "LtiDeepLinkingRequest",
});

describe("policySelectActivities", () => {
  it("lets the offering's teacher place its activities, titled from the catalog", async () => {
    const { engine, activities } = createDistrict();
    const select = policySelectActivities({ authorizer: engine, activities });
    expect(await select(launchAs(MORGAN, "staff"), [CELL_LAB, CELL_LAB])).toEqual([{ activityId: CELL_LAB, title: "Cell lab" }]);
  });

  it("refuses a student, and an activity from another offering", async () => {
    const { engine, activities, audit } = createDistrict();
    const select = policySelectActivities({ authorizer: engine, activities });
    expect(await rejection(select(launchAs(AMARA, "student"), [CELL_LAB]))).toBe("forbidden");
    expect(audit.at(-1)).toMatchObject({ principalId: AMARA, action: "assign", resourceKind: "activity", effect: "deny" });
    expect(await rejection(select(launchAs(MORGAN, "staff"), [CELL_LAB, ESSAY]))).toBe("not-found");
    expect(await rejection(select(launchAs(MORGAN, "staff"), ["act_ghost" as never]))).toBe("not-found");
  });
});

describe("districtPrincipalResolver", () => {
  it("resolves against the directory as it is at each launch, and serves only its own district", async () => {
    const { academics } = createDistrict();
    const resolver = districtPrincipalResolver(NF, academics);
    expect(await resolver("dst_riverbend" as never)).toBeUndefined();

    const first = await resolver(NF);
    const identity = { issuer: NF_CANVAS, subject: "lti-new-student", credential: "person" as const };
    expect(await rejection(first!.resolve(identity))).toBe("unauthenticated");

    // Link the subject to Felix in the directory: the next launch sees it.
    const { snapshot, version } = await academics.load();
    const next: DistrictDirectorySnapshot = {
      ...snapshot,
      principals: snapshot.principals.map((p) =>
        p.id === "prn_nf-student-felix" ? { ...p, externalIdentities: [...p.externalIdentities, { districtId: NF, issuer: NF_CANVAS, subject: "lti-new-student" }] } : p,
      ),
    };
    await academics.commit(next, version);
    expect(await (await resolver(NF))!.resolve(identity)).toMatchObject({ principalId: "prn_nf-student-felix", kind: "student" });
  });
});
