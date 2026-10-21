// SCHO-70: after every roster apply, W01 reconciles course grants as the roster service principal
// and G01 drains the funding cancellations that emitted.
import { NO_FUNDING_CANCELLATIONS, type CourseFundingCancellations } from "@schoolos/ai-governance";
import { DistrictDirectorySnapshot, PrincipalId, type VerifiedPrincipal } from "@schoolos/contracts";
import { RetentionPolicy, WorkspaceDirectory } from "@schoolos/workspaces";
import { describe, expect, it } from "vitest";
import { reconcileAfterRosterApply, type FundingCancellationStore } from "../src/index.ts";
import { bootDistrict, NF, NORTHFIELD } from "./support.ts";

const ROSTER_SERVICE = PrincipalId.parse("prn_nf-roster-service");

/** Northfield with a roster service principal granted district administration. */
const WITH_SERVICE = DistrictDirectorySnapshot.parse({
  ...NORTHFIELD,
  principals: [
    ...NORTHFIELD.principals,
    {
      id: ROSTER_SERVICE,
      districtId: NORTHFIELD.district.id,
      kind: "service",
      status: "active",
      displayName: "Roster sync",
      externalIdentities: [{ districtId: NORTHFIELD.district.id, issuer: NORTHFIELD.district.trustedIssuers[0]!, subject: "svc-roster-sync" }],
    },
  ],
  roleAssignments: [
    ...NORTHFIELD.roleAssignments,
    { principalId: ROSTER_SERVICE, role: "district-admin", scope: { level: "district", districtId: NORTHFIELD.district.id }, source: "local-grant" },
  ],
});

class MemoryCancellations implements FundingCancellationStore {
  record: CourseFundingCancellations = NO_FUNDING_CANCELLATIONS;
  async load() {
    return this.record;
  }
  async save(next: CourseFundingCancellations) {
    this.record = next;
  }
}

async function setup() {
  const district = await bootDistrict(WITH_SERVICE);
  const { stores } = district.app;
  // Amara opens her Biology workspace, which gives her live course grants.
  await district.ok(district.tokenFor(NF.amara), "student.openCourseWorkspace", { params: { offeringId: NF.bio } });
  // The roster then drops her from Biology, and the apply commits the directory.
  const { version, snapshot } = await stores.directory.load();
  await stores.directory.commit({
    ...snapshot,
    enrollments: snapshot.enrollments.map((e) => (e.principalId === NF.amara && e.offeringId === NF.bio ? { ...e, status: "inactive" } : e)),
  }, version);
  const workspaces = new WorkspaceDirectory({
    workspaces: stores.workspaces,
    directory: stores.directory,
    policy: { decide: (request) => district.app.engine.decide(request, { correlationId: "roster-sync" }) },
    retention: RetentionPolicy.parse({ courseWorkspaceRetentionDays: 365 }),
  });
  const cancellations = new MemoryCancellations();
  const reconcile = (rosterService: VerifiedPrincipal) =>
    reconcileAfterRosterApply({ workspaces, workspaceStore: stores.workspaces, directory: stores.directory, rosterService, fundingCancellations: cancellations });
  return { reconcile, cancellations };
}

describe("reconcileAfterRosterApply", () => {
  it("revokes a dropped student's grants as the roster service and drains the cancellation into G01, once", async () => {
    const { reconcile, cancellations } = await setup();
    const service = { principalId: ROSTER_SERVICE, districtId: NORTHFIELD.district.id };

    expect(await reconcile(service)).toEqual({ grantsRevoked: 2, cancellationsDrained: 1 });
    expect(cancellations.record.cancelled).toMatchObject([{ offeringId: NF.bio, principalId: NF.amara }]);

    // Running it again after the next apply changes nothing.
    expect(await reconcile(service)).toEqual({ grantsRevoked: 0, cancellationsDrained: 0 });
    expect(cancellations.record.cancelled).toHaveLength(1);
  });

  it("is refused for a principal without authority over the district's enrollments", async () => {
    const { reconcile, cancellations } = await setup();
    await expect(reconcile({ principalId: PrincipalId.parse(NF.rivera), districtId: NORTHFIELD.district.id }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(cancellations.record).toEqual(NO_FUNDING_CANCELLATIONS);
  });
});
