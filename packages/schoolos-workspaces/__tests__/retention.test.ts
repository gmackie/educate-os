import { describe, expect, it } from "vitest";
import { PrincipalId, type WorkspaceId } from "@schoolos/contracts";
import {
  WorkspaceRetentionJob,
  type CourseWorkspace,
  type WorkspaceState,
  type WorkspaceStorageEraser,
  type WorkspaceStore,
} from "../src/index.ts";
import { O, P, RETENTION_DAYS, rejectsWith, setTermState, setup, T } from "./setup.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const JOB = PrincipalId.parse("prn_nf-retention-job");

/** An eraser that records each call and runs `before` first, so a test can fail or race it. */
class RecordingEraser implements WorkspaceStorageEraser {
  readonly erased: WorkspaceId[] = [];
  before: (workspace: CourseWorkspace) => Promise<void> = async () => {};

  async eraseWorkspace(workspace: CourseWorkspace): Promise<void> {
    await this.before(workspace);
    this.erased.push(workspace.id);
  }
}

/** A store whose next commit throws, as if the job's process stopped right there. */
class InterruptibleStore implements WorkspaceStore {
  readonly #inner: WorkspaceStore;
  failNextCommit = false;

  constructor(inner: WorkspaceStore) {
    this.#inner = inner;
  }

  load() {
    return this.#inner.load();
  }

  async commit(next: WorkspaceState, expectedVersion: number): Promise<void> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("the job stopped");
    }
    await this.#inner.commit(next, expectedVersion);
  }
}

/** Amara's and Elena's Biology workspaces in a closed fall term, and a retention job over them. */
async function closedFall() {
  const ctx = setup();
  const amaraBio = await ctx.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  const elenaBio = await ctx.workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
  await ctx.workspaces.ensurePersonalWorkspace(P.amara);
  await ctx.changeDirectory((d) => setTermState(d, T.fall, "completed"));
  await ctx.workspaces.closeTerm(P.nfAdmin, T.fall);
  const eraser = new RecordingEraser();
  const store = new InterruptibleStore(ctx.store);
  const job = new WorkspaceRetentionJob({
    workspaces: store,
    directory: ctx.academics,
    retention: { courseWorkspaceRetentionDays: RETENTION_DAYS },
    eraser,
    runAs: JOB,
    now: () => ctx.clock.now,
  });
  const afterRetention = () => {
    ctx.clock.now = new Date(ctx.clock.now.getTime() + RETENTION_DAYS * DAY_MS);
  };
  return { ...ctx, amaraBio, elenaBio, eraser, interruptible: store, job, afterRetention };
}

describe("the retention deletion job", () => {
  it("deletes nothing before the retention period ends", async () => {
    const { job, eraser, store } = await closedFall();
    expect(await job.run()).toEqual({ deleted: [], failed: [] });
    expect(eraser.erased).toEqual([]);
    expect((await store.load()).state.deletions).toEqual([]);
  });

  it("deletes each eligible workspace's storage once, with one audit record each, and keeps a tombstone", async () => {
    const { job, eraser, store, workspaces, amaraBio, elenaBio, afterRetention } = await closedFall();
    afterRetention();
    const result = await job.run();
    expect(result.deleted.toSorted()).toEqual([amaraBio.id, elenaBio.id].toSorted());
    expect(eraser.erased.toSorted()).toEqual([amaraBio.id, elenaBio.id].toSorted());

    const { state } = await store.load();
    expect(state.deletions).toHaveLength(2);
    expect(state.deletions.find((d) => d.target.workspaceId === amaraBio.id)).toEqual({
      districtId: "dst_northfield",
      actor: { principalId: JOB },
      at: expect.any(String),
      action: "workspace.storage-deleted",
      target: { workspaceId: amaraBio.id, ownerPrincipalId: "prn_nf-student-amara", offeringId: O.bioFall, termId: T.fall },
      retention: { closedAt: "2026-10-20T12:00:00.000Z", eligibleFrom: "2026-11-19T12:00:00.000Z" },
    });
    // The owner still sees that the work existed, and that it was deleted; the personal workspace is untouched.
    expect((await workspaces.getWorkspace(P.amara, amaraBio.id)).lifecycle).toBe("deleted");
    expect(state.workspaces.filter((w) => w.kind === "personal").every((w) => w.deletion === undefined)).toBe(true);

    expect(await job.run()).toEqual({ deleted: [], failed: [] });
    expect(eraser.erased).toHaveLength(2);
    expect((await store.load()).state.deletions).toHaveLength(2);
  });

  it("never deletes a workspace on legal hold", async () => {
    const { job, eraser, store, workspaces, amaraBio, elenaBio, afterRetention } = await closedFall();
    await workspaces.setLegalHold(P.nfAdmin, amaraBio.id, true);
    afterRetention();
    expect((await job.run()).deleted).toEqual([elenaBio.id]);
    expect(eraser.erased).toEqual([elenaBio.id]);
    expect((await store.load()).state.workspaces.find((w) => w.id === amaraBio.id)?.deletion).toBeUndefined();
  });

  it("re-checks the legal hold at the moment it deletes, not when it listed the eligible workspaces", async () => {
    const { job, eraser, workspaces, amaraBio, elenaBio, afterRetention } = await closedFall();
    afterRetention();
    // Both are eligible when the run starts (Amara's first); a hold arrives on Elena's while Amara's is erased.
    eraser.before = async (workspace) => {
      if (workspace.id === amaraBio.id) await workspaces.setLegalHold(P.nfAdmin, elenaBio.id, true);
    };
    expect((await job.run()).deleted).toEqual([amaraBio.id]);
    expect(eraser.erased).toEqual([amaraBio.id]);
    expect((await workspaces.getWorkspace(P.elena, elenaBio.id)).lifecycle).toBe("retained");
  });

  it("refuses a legal hold once deletion has begun, and resumes an interrupted erase on the next run", async () => {
    const { job, eraser, store, workspaces, amaraBio, elenaBio, afterRetention } = await closedFall();
    afterRetention();
    eraser.before = async (workspace) => {
      if (workspace.id === amaraBio.id) throw new Error("storage is unavailable");
    };
    expect(await job.run()).toEqual({ deleted: [elenaBio.id], failed: [amaraBio.id] });
    expect((await store.load()).state.workspaces.find((w) => w.id === amaraBio.id)?.deletion).toMatchObject({ state: "pending" });
    expect((await workspaces.getWorkspace(P.amara, amaraBio.id)).lifecycle).toBe("eligible-for-deletion");
    await rejectsWith(workspaces.setLegalHold(P.nfAdmin, amaraBio.id, true), "conflict");

    eraser.before = async () => {};
    expect(await job.run()).toEqual({ deleted: [amaraBio.id], failed: [] });
    expect((await store.load()).state.deletions.map((d) => d.target.workspaceId).toSorted()).toEqual([amaraBio.id, elenaBio.id].toSorted());
  });

  it("erases again but records once when it stops after erasing and before recording", async () => {
    const { job, eraser, store, interruptible, amaraBio, afterRetention } = await closedFall();
    afterRetention();
    eraser.before = async (workspace) => {
      // The erase succeeds; the commit after it never lands.
      if (workspace.id === amaraBio.id && eraser.erased.length === 0) interruptible.failNextCommit = true;
    };
    await expect(job.run()).rejects.toThrow("the job stopped");
    expect(eraser.erased).toEqual([amaraBio.id]);
    expect((await store.load()).state.deletions).toEqual([]);

    const resumed = await job.run();
    expect(resumed.deleted).toContain(amaraBio.id);
    expect(eraser.erased.filter((id) => id === amaraBio.id)).toHaveLength(2);
    const { state } = await store.load();
    expect(state.deletions.filter((d) => d.target.workspaceId === amaraBio.id)).toHaveLength(1);
  });
});
