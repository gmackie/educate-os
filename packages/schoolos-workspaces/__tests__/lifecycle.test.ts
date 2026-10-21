import { describe, expect, it } from "vitest";
import { ArtifactId, EnrollmentId, PrincipalId } from "@schoolos/contracts";
import { AcademicDirectory } from "@schoolos/academics";
import { transitionPrincipal } from "../src/index.ts";
import { ALL_LOCAL, O, P, RETENTION_DAYS, rejectsWith, setTermState, setup, T } from "./setup.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function drop(enrollmentId: string) {
  return (draft: { enrollments: { id: string; status: string }[] }) => {
    draft.enrollments.find((e) => e.id === EnrollmentId.parse(enrollmentId))!.status = "inactive";
  };
}

/** Amara and Elena with Biology workspaces, and the fall term then completed in the directory. */
async function fallCompleted() {
  const ctx = setup();
  const amaraBio = await ctx.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  const elenaBio = await ctx.workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
  await ctx.changeDirectory((d) => setTermState(d, T.fall, "completed"));
  return { ...ctx, amaraBio, elenaBio };
}

describe("a roster drop", () => {
  it("keeps the student's workspace readable to them but revokes its live grants", async () => {
    const { workspaces, store, changeDirectory } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    await workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
    await changeDirectory(drop("enr_nf-02"));

    expect(await workspaces.reconcileCourseGrants(P.nfAdmin)).toEqual({ revoked: 2 });
    const { state } = await store.load();
    expect(state.workspaces).toHaveLength(2);
    expect(state.grants.filter((g) => g.workspaceId === bio.id).map((g) => [g.state, g.state === "revoked" && g.reason])).toEqual([
      ["revoked", "roster-dropped"],
      ["revoked", "roster-dropped"],
    ]);
    expect(state.grants.filter((g) => g.principalId === "prn_nf-student-elena").every((g) => g.state === "live")).toBe(true);
    expect(state.events).toEqual([
      expect.objectContaining({ type: "course-ai-funding.cancelled", offeringId: O.bioFall, principalIds: ["prn_nf-student-amara"], reason: "roster-dropped" }),
    ]);
    // The workspace's life follows the term, never the roster.
    expect(await workspaces.getWorkspace(P.amara, bio.id)).toMatchObject({ id: bio.id, lifecycle: "active" });
    expect(await workspaces.reconcileCourseGrants(P.nfAdmin)).toEqual({ revoked: 0 });
  });

  it("reissues grants when the student is enrolled again", async () => {
    const { workspaces, store, changeDirectory } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    await changeDirectory(drop("enr_nf-02"));
    await workspaces.reconcileCourseGrants(P.nfAdmin);
    // Still dropped: ensuring returns the kept workspace and grants nothing.
    expect((await workspaces.ensureCourseWorkspace(P.amara, O.bioFall)).id).toBe(bio.id);
    expect((await store.load()).state.grants.filter((g) => g.state === "live")).toEqual([]);

    await changeDirectory((d) => {
      d.enrollments.find((e) => e.id === "enr_nf-02")!.status = "active";
    });
    await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    expect((await store.load()).state.grants.filter((g) => g.state === "live")).toHaveLength(2);
  });

  it("is reconciled only by someone who manages the district's enrollments", async () => {
    const { workspaces } = setup();
    for (const caller of [P.morgan, P.amara, P.highPrincipal]) {
      await rejectsWith(workspaces.reconcileCourseGrants(caller), "forbidden");
    }
  });
});

describe("closing a term", () => {
  it("retains its course workspaces, revokes their grants and cancels course AI funding", async () => {
    const { workspaces, store, amaraBio, elenaBio } = await fallCompleted();
    expect((await workspaces.getWorkspace(P.amara, amaraBio.id)).lifecycle).toBe("completed");

    expect(await workspaces.closeTerm(P.nfAdmin, T.fall)).toEqual({ retained: 2, grantsRevoked: 4, fundingCancellations: 4 });
    const { state } = await store.load();
    expect(state.grants.every((g) => g.state === "revoked" && g.reason === "term-closed")).toBe(true);
    expect(state.events.map((e) => [e.offeringId, e.principalIds.toSorted()])).toEqual(
      expect.arrayContaining([
        ["off_nf-bio-fall-p2", ["prn_nf-student-amara", "prn_nf-student-elena"]],
        ["off_nf-eng9-fall-p3", []],
        ["off_nf-ushist-fall-p5", []],
        ["off_nf-math7-fall-p1", []],
      ]),
    );
    expect(state.events.every((e) => e.reason === "term-closed" && e.termId === T.fall)).toBe(true);

    // The owner keeps reading their history; the teacher still sees the records, without contents.
    expect(await workspaces.getWorkspace(P.amara, amaraBio.id)).toMatchObject({ lifecycle: "retained" });
    expect(await workspaces.getWorkspace(P.elena, elenaBio.id)).toMatchObject({ lifecycle: "retained" });
    expect((await workspaces.listOfferingWorkspaces(P.morgan, O.bioFall)).map((w) => w.lifecycle)).toEqual(["retained", "retained"]);
    // No new course work starts in a closed term.
    await rejectsWith(workspaces.ensureCourseWorkspace(P.dmitri, O.bioFall), "forbidden");
  });

  it("is idempotent", async () => {
    const { workspaces, store } = await fallCompleted();
    await workspaces.closeTerm(P.nfAdmin, T.fall);
    const before = (await store.load()).state;
    expect(await workspaces.closeTerm(P.nfAdmin, T.fall)).toEqual({ retained: 0, grantsRevoked: 0, fundingCancellations: 0 });
    expect((await store.load()).state).toEqual(before);
  });

  it("refuses a term that is not yet completed, and anyone but a district admin", async () => {
    const { workspaces, store } = setup();
    await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    await rejectsWith(workspaces.closeTerm(P.nfAdmin, T.fall), "conflict");
    for (const caller of [P.morgan, P.highPrincipal, P.amara]) {
      await rejectsWith(workspaces.closeTerm(caller, T.spring), "forbidden");
      await rejectsWith(workspaces.previewTermRollover(caller, T.spring), "forbidden");
    }
    await rejectsWith(workspaces.closeTerm(P.rbAdmin, T.spring), "forbidden");
    expect((await store.load()).state.closures).toEqual([]);
  });
});

describe("retention and legal hold", () => {
  it("makes a closed course workspace eligible for deletion only after the retention period", async () => {
    const { workspaces, clock, amaraBio } = await fallCompleted();
    await workspaces.closeTerm(P.nfAdmin, T.fall);
    const closedAt = clock.now.getTime();
    clock.now = new Date(closedAt + (RETENTION_DAYS * DAY_MS) - 1);
    expect((await workspaces.getWorkspace(P.amara, amaraBio.id)).lifecycle).toBe("retained");
    clock.now = new Date(closedAt + RETENTION_DAYS * DAY_MS);
    expect((await workspaces.getWorkspace(P.amara, amaraBio.id)).lifecycle).toBe("eligible-for-deletion");
  });

  it("keeps a held workspace retained past the retention period until the hold is lifted", async () => {
    const { workspaces, clock, store, amaraBio, elenaBio } = await fallCompleted();
    await workspaces.setLegalHold(P.nfAdmin, amaraBio.id, true);
    expect((await workspaces.previewTermRollover(P.nfAdmin, T.fall)).workspaces).toEqual({ toRetain: 2, onLegalHold: 1 });
    await workspaces.closeTerm(P.nfAdmin, T.fall);
    clock.now = new Date(clock.now.getTime() + 365 * DAY_MS);

    expect((await workspaces.getWorkspace(P.amara, amaraBio.id)).lifecycle).toBe("retained");
    expect((await workspaces.getWorkspace(P.elena, elenaBio.id)).lifecycle).toBe("eligible-for-deletion");
    expect((await store.load()).state.workspaces.find((w) => w.id === amaraBio.id)?.legalHold).toMatchObject({
      placedBy: PrincipalId.parse("prn_nf-district-admin"),
    });

    await workspaces.setLegalHold(P.nfAdmin, amaraBio.id, false);
    expect((await workspaces.getWorkspace(P.amara, amaraBio.id)).lifecycle).toBe("eligible-for-deletion");
  });

  it("lets only a district admin hold a workspace, and holding one does not open it to them", async () => {
    const { workspaces, amaraBio } = await fallCompleted();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    for (const caller of [P.morgan, P.highPrincipal, P.amara]) {
      await rejectsWith(workspaces.setLegalHold(caller, amaraBio.id, true), "forbidden");
    }
    await workspaces.setLegalHold(P.nfAdmin, personal.id, true);
    await rejectsWith(workspaces.getWorkspace(P.nfAdmin, personal.id), "not-found");
    expect((await workspaces.getWorkspace(P.amara, personal.id)).legalHold).toBeDefined();
  });
});

describe("personal workspace records for retention (SCHO-56)", () => {
  it("lists every personal workspace's record to a district admin, never its contents", async () => {
    const { workspaces, store, audit } = setup();
    const amara = await workspaces.ensurePersonalWorkspace(P.amara);
    await workspaces.ensurePersonalWorkspace(P.elena);
    const { state, version } = await store.load();
    const handle = { backend: "workshop" as const, ref: "ws-amara-personal" };
    await store.commit({ ...state, workspaces: state.workspaces.map((w) => (w.id === amara.id ? { ...w, storageHandle: handle } : w)) }, version);
    await workspaces.setLegalHold(P.nfAdmin, amara.id, true);

    const records = await workspaces.listPersonalWorkspaceRecords(P.nfAdmin);
    expect(records.map((r) => r.ownerPrincipalId).toSorted()).toEqual([P.amara.principal.principalId, P.elena.principal.principalId]);
    expect(records.find((r) => r.id === amara.id)).toMatchObject({ kind: "personal", legalHold: { placedBy: P.nfAdmin.principal.principalId } });
    expect(JSON.stringify(records)).not.toContain(handle.ref);
    expect(audit.events.findLast((e) => e.resourceKind === "personal-workspace" && e.action === "list"))
      .toMatchObject({ effect: "allow", ruleId: "admin.retention.personal-workspace-records" });
    // The listing opens none of them.
    await rejectsWith(workspaces.getWorkspace(P.nfAdmin, amara.id), "not-found");
  });

  it("refuses everyone but a district admin", async () => {
    const { workspaces } = setup();
    await workspaces.ensurePersonalWorkspace(P.amara);
    for (const caller of [P.highPrincipal, P.morgan, P.amara, P.rbAdmin]) {
      await rejectsWith(workspaces.listPersonalWorkspaceRecords(caller), "forbidden");
    }
  });
});

describe("promotion to the personal workspace", () => {
  const essay = ArtifactId.parse("art_cell-respiration-essay");

  it("waits for the class to close", async () => {
    const { workspaces, amaraBio } = await fallCompleted();
    await rejectsWith(workspaces.promoteArtifact(P.amara, amaraBio.id, essay), "conflict");
  });

  it("links the artifact into the owner's personal workspace, once", async () => {
    const { workspaces, store, amaraBio } = await fallCompleted();
    await workspaces.closeTerm(P.nfAdmin, T.fall);
    const link = await workspaces.promoteArtifact(P.amara, amaraBio.id, essay);
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    expect(link).toMatchObject({ principalId: "prn_nf-student-amara", fromWorkspaceId: amaraBio.id, toWorkspaceId: personal.id, artifactId: essay });
    expect(await workspaces.promoteArtifact(P.amara, amaraBio.id, essay)).toEqual(link);
    expect((await store.load()).state.promotions).toHaveLength(1);
  });

  it("is refused to everyone but the owner", async () => {
    const { workspaces, store, amaraBio } = await fallCompleted();
    await workspaces.closeTerm(P.nfAdmin, T.fall);
    for (const caller of [P.elena, P.morgan, P.nfAdmin]) {
      await rejectsWith(workspaces.promoteArtifact(caller, amaraBio.id, essay), "not-found");
    }
    expect((await store.load()).state.promotions).toEqual([]);
  });
});

/** The academic directory over the same store and engine, owning its principals. */
async function graduationSetup() {
  const ctx = setup();
  const directory = new AcademicDirectory({ store: ctx.academics, authority: ALL_LOCAL, authorizer: ctx.engine });
  const bio = await ctx.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  await ctx.workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
  return { ...ctx, services: { academics: directory, workspaces: ctx.workspaces }, bio };
}

describe("a principal's graduation", () => {
  it("revokes the graduate's grants and cancels their AI funding, keeping their workspaces and everyone else's grants", async () => {
    const { services, workspaces, store, audit, bio } = await graduationSetup();
    const result = await transitionPrincipal(services, P.nfAdmin, P.amara.principal.principalId, "graduated");
    expect(result).toMatchObject({ principal: { id: P.amara.principal.principalId, status: "graduated" }, grantsRevoked: 2 });

    const { state } = await store.load();
    expect(state.workspaces.map((w) => w.id)).toContain(bio.id);
    expect(state.grants.filter((g) => g.workspaceId === bio.id).map((g) => [g.state, g.state === "revoked" && g.reason])).toStrictEqual([
      ["revoked", "principal-departed"],
      ["revoked", "principal-departed"],
    ]);
    expect(state.grants.filter((g) => g.principalId === P.elena.principal.principalId).every((g) => g.state === "live")).toBe(true);
    expect(state.events).toStrictEqual([
      expect.objectContaining({ type: "course-ai-funding.cancelled", offeringId: O.bioFall, principalIds: [P.amara.principal.principalId], reason: "principal-departed" }),
    ]);
    // Her enrollment is untouched, and opening the class finds her kept workspace, but grants nothing.
    expect((await workspaces.ensureCourseWorkspace(P.amara, O.bioFall)).id).toBe(bio.id);
    expect((await store.load()).state.grants.filter((g) => g.principalId === P.amara.principal.principalId && g.state === "live")).toStrictEqual([]);
    // Both steps were decided, and audited, as the administrator.
    expect(audit.events.some((e) => e.resourceKind === "principal" && e.action === "update" && e.principalId === P.nfAdmin.principal.principalId && e.effect === "allow")).toBe(true);
  });

  it("is refused before anything changes for anyone but a district administrator", async () => {
    const { services, store, academics } = await graduationSetup();
    const before = { workspaces: await store.load(), directory: await academics.load() };
    for (const caller of [P.rivera, P.amara, P.rbAdmin]) {
      await rejectsWith(transitionPrincipal(services, caller, P.amara.principal.principalId, "graduated"), "not-found");
    }
    expect(await store.load()).toStrictEqual(before.workspaces);
    expect(await academics.load()).toStrictEqual(before.directory);
  });
});
