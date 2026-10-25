import { describe, expect, it } from "vitest";
import type { WorkspaceId } from "@educateos/contracts";
import { O, P, rejectsWith, setup } from "./setup.ts";

/** Amara and Elena each with a personal workspace and a Biology workspace that has storage attached. */
async function populated() {
  const ctx = setup();
  const { workspaces, store } = ctx;
  const amaraPersonal = await workspaces.ensurePersonalWorkspace(P.amara);
  const amaraBio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  const elenaBio = await workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
  await workspaces.ensureCourseWorkspace(P.amara, O.eng9);
  // Attach storage the way the kernel seam will, so the tests can check who is given it.
  const { state, version } = await store.load();
  state.workspaces = state.workspaces.map((w) => ({ ...w, storageHandle: { backend: "workshop", ref: `ws-${w.id}` } }));
  await store.commit(state, version);
  return { ...ctx, amaraPersonal, amaraBio, elenaBio };
}

describe("workspace access", () => {
  it("gives the owner their workspaces, with the storage handle", async () => {
    const { workspaces, amaraPersonal, amaraBio } = await populated();
    const mine = await workspaces.listMyWorkspaces(P.amara);
    expect(mine.map((w) => w.kind).toSorted()).toEqual(["course", "course", "personal"]);
    expect(mine.every((w) => w.storageHandle !== undefined)).toBe(true);
    expect((await workspaces.getWorkspace(P.amara, amaraPersonal.id)).storageHandle).toBeDefined();
    expect((await workspaces.getWorkspace(P.amara, amaraBio.id)).storageHandle).toBeDefined();
  });

  it("shows a teacher their offering's course workspaces as records only, never a personal workspace", async () => {
    const { workspaces, amaraPersonal } = await populated();
    const listed = await workspaces.listOfferingWorkspaces(P.morgan, O.bioFall);
    expect(listed.map((w) => w.ownerPrincipalId).toSorted()).toEqual(["prn_nf-student-amara", "prn_nf-student-elena"]);
    expect(listed.every((w) => w.kind === "course" && w.offeringId === O.bioFall)).toBe(true);
    // No reference to a workspace's contents reaches anyone but its owner.
    expect(listed.every((w) => w.storageHandle === undefined)).toBe(true);
    expect(await workspaces.listMyWorkspaces(P.morgan)).toEqual([]);
    await rejectsWith(workspaces.getWorkspace(P.morgan, amaraPersonal.id), "not-found");
  });

  it("keeps a personal workspace from teachers and administrators alike, and audits the denial", async () => {
    const { workspaces, audit, amaraPersonal } = await populated();
    for (const caller of [P.morgan, P.rivera, P.highPrincipal, P.nfAdmin]) {
      await rejectsWith(workspaces.getWorkspace(caller, amaraPersonal.id), "not-found");
      expect(audit.events.at(-1)).toMatchObject({
        resourceKind: "personal-workspace",
        resourceId: amaraPersonal.id,
        effect: "deny",
        ruleId: "guard.personal.owner-only",
      });
    }
  });

  it("does not let a student see another student's workspace, by ID or by listing", async () => {
    const { workspaces, amaraPersonal, amaraBio, elenaBio } = await populated();
    await rejectsWith(workspaces.getWorkspace(P.elena, amaraBio.id), "not-found");
    await rejectsWith(workspaces.getWorkspace(P.elena, amaraPersonal.id), "not-found");
    expect((await workspaces.listOfferingWorkspaces(P.elena, O.bioFall)).map((w) => w.id)).toEqual([elenaBio.id]);
    // Chidi is not in the class at all.
    await rejectsWith(workspaces.listOfferingWorkspaces(P.chidi, O.bioFall), "not-found");
  });

  it("limits a teacher to their own offerings", async () => {
    const { workspaces, amaraBio } = await populated();
    await rejectsWith(workspaces.getWorkspace(P.rivera, amaraBio.id), "not-found");
    expect((await workspaces.listOfferingWorkspaces(P.rivera, O.eng9)).map((w) => w.ownerPrincipalId)).toEqual(["prn_nf-student-amara"]);
  });

  it("answers another district and unknown IDs alike with not-found", async () => {
    const { workspaces, amaraBio } = await populated();
    await rejectsWith(workspaces.getWorkspace(P.rbAdmin, amaraBio.id), "not-found");
    await rejectsWith(workspaces.listOfferingWorkspaces(P.rbAdmin, O.bioFall), "not-found");
    await rejectsWith(workspaces.getWorkspace(P.amara, "wsp_does-not-exist" as WorkspaceId), "not-found");
  });
});
