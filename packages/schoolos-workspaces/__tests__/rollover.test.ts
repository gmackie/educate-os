import { describe, expect, it } from "vitest";
import { O, P, setTermState, setup, T } from "./setup.ts";

describe("the term rollover preview on Northfield", () => {
  it("shows the spring term, already completed, as ready to close with nothing provisioned in it", async () => {
    const { workspaces } = setup();
    // Amara's spring enrollment is still active, but she never opened the class, and a completed
    // term provisions nothing new, so closing it retains no workspace and revokes no grant.
    expect(await workspaces.previewTermRollover(P.nfAdmin, T.spring)).toEqual({
      termId: T.spring,
      termState: "completed",
      alreadyClosed: false,
      canClose: true,
      offerings: 1,
      workspaces: { toRetain: 0, onLegalHold: 0 },
      grants: { toRevoke: 0 },
      principals: { students: 1, staff: 1 },
    });

    expect(await workspaces.closeTerm(P.nfAdmin, T.spring)).toEqual({ retained: 0, grantsRevoked: 0, fundingCancellations: 1 });
    expect(await workspaces.previewTermRollover(P.nfAdmin, T.spring)).toMatchObject({ alreadyClosed: true, canClose: false });
  });

  it("counts the active fall term's workspaces, grants and enrolled principals without closing it", async () => {
    const { workspaces, store } = setup();
    await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    await workspaces.ensureCourseWorkspace(P.amara, O.eng9);
    await workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
    await workspaces.ensurePersonalWorkspace(P.amara);

    expect(await workspaces.previewTermRollover(P.nfAdmin, T.fall)).toEqual({
      termId: T.fall,
      termState: "active",
      alreadyClosed: false,
      canClose: false,
      offerings: 4,
      workspaces: { toRetain: 3, onLegalHold: 0 },
      grants: { toRevoke: 6 },
      // Amara, Dmitri, Elena, Chidi and Felix; Dmitri's dropped English 9 enrollment does not count twice.
      // Staff: Morgan, Rivera, Chen (teacher and co-teacher) and Patel.
      principals: { students: 5, staff: 4 },
    });
    const { state } = await store.load();
    expect(state.closures).toEqual([]);
    expect(state.grants.every((g) => g.state === "live")).toBe(true);
  });

  it("reports what is ready once the fall term is completed in the directory", async () => {
    const { workspaces, changeDirectory } = setup();
    await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    await changeDirectory((d) => setTermState(d, T.fall, "completed"));
    expect(await workspaces.previewTermRollover(P.nfAdmin, T.fall)).toMatchObject({
      termState: "completed",
      canClose: true,
      workspaces: { toRetain: 1, onLegalHold: 0 },
      grants: { toRevoke: 2 },
    });
  });
});
