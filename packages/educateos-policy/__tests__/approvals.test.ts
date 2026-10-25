import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ArtifactId, OfferingId, PrincipalId } from "@educateos/contracts";
import {
  InMemoryToolApprovalStore,
  SchoolToolRunner,
  defineSchoolTool,
  type SchoolToolContext,
  type SchoolToolOutcome,
  type ToolDecisionOutcome,
} from "../src/index.ts";
import { courseResource, engineFor, P } from "./setup.ts";

const BIO = "off_nf-bio-fall-p2";
const ENG9 = "off_nf-eng9-fall-p3";
const DAY = 24 * 60 * 60 * 1000;

function queueFor() {
  const { engine, audit, store: directory } = engineFor();
  const store = new InMemoryToolApprovalStore();
  let now = new Date("2026-10-01T12:00:00Z");
  const clock = { advance: (ms: number) => void (now = new Date(now.getTime() + ms)) };
  const ran: { tool: string; context: SchoolToolContext; input: unknown }[] = [];
  const artifacts = new Map([["art_amara-lab", { offeringId: BIO, owner: "prn_nf-student-amara", text: "v1" }]]);
  let failNext = false;

  const recordGrade = defineSchoolTool({
    name: "record_grade",
    description: "Record an official grade.",
    inputSchema: z.strictObject({ offeringId: OfferingId, studentId: PrincipalId, score: z.number().min(0).max(100) }),
    action: "grade",
    annotations: { readOnlyHint: true },
    resource: async ({ offeringId, studentId }) => courseResource(offeringId, "official-grade", "course", { owner: studentId }),
    handler: async (input, context) => {
      if (failNext) {
        failNext = false;
        throw new Error("gradebook unavailable");
      }
      ran.push({ tool: "record_grade", context, input });
      return { recorded: input.score };
    },
  });
  const editArtifact = defineSchoolTool({
    name: "edit_artifact",
    description: "Replace an artifact's text.",
    inputSchema: z.strictObject({ artifactId: ArtifactId, text: z.string().max(1000) }),
    action: "update",
    resource: async ({ artifactId }) => {
      const artifact = artifacts.get(artifactId);
      return artifact && courseResource(artifact.offeringId, "artifact", "course", { id: artifactId, owner: artifact.owner });
    },
    handler: async ({ artifactId, text }, context) => {
      ran.push({ tool: "edit_artifact", context, input: { artifactId, text } });
      artifacts.get(artifactId)!.text = text;
      return { ok: true };
    },
  });
  const readArtifact = defineSchoolTool({
    name: "read_artifact",
    description: "Read an artifact.",
    inputSchema: z.strictObject({ artifactId: ArtifactId }),
    action: "read",
    resource: async ({ artifactId }) => {
      const artifact = artifacts.get(artifactId);
      return artifact && courseResource(artifact.offeringId, "artifact", "course", { id: artifactId, owner: artifact.owner });
    },
    handler: async ({ artifactId }) => artifacts.get(artifactId)!.text,
  });

  const runner = new SchoolToolRunner({
    tools: [recordGrade, editArtifact, readArtifact],
    engine,
    approvals: { store, now: () => now, ttlMs: 3 * DAY },
  });
  return { runner, store, audit, directory, ran, artifacts, clock, failOnce: () => void (failNext = true) };
}

const agent = (principal: typeof P.amara) => ({ principal, channel: "agent" as const });
const person = (principal: typeof P.amara) => ({ principal, channel: "http" as const });
const gradeFor = (offeringId: string, studentId: string, score = 91) => ({ offeringId, studentId, score });

function approvalIdOf(outcome: SchoolToolOutcome): string {
  if (outcome.status !== "approval-required" || outcome.approvalId === undefined) {
    throw new Error(`expected a queued action, got ${JSON.stringify(outcome)}`);
  }
  return outcome.approvalId;
}

function errorCode(outcome: ToolDecisionOutcome): string | undefined {
  return outcome.status === "error" ? outcome.error.code : undefined;
}

describe("the tool approval queue", () => {
  it("persists a require-approval call exactly as it will run, and runs nothing", async () => {
    const { runner, store, ran } = queueFor();
    const outcome = await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara"));
    expect(outcome).toMatchObject({ status: "approval-required", needs: "approval", approvalId: expect.stringMatching(/^apr_/) });

    const stored = await store.get(approvalIdOf(outcome));
    expect(stored).toMatchObject({
      tool: "record_grade",
      input: gradeFor(BIO, "prn_nf-student-amara"),
      subject: P.morgan,
      channel: "agent",
      correlationId: (outcome as { correlationId: string }).correlationId,
      state: "pending",
      createdAt: "2026-10-01T12:00:00.000Z",
      expiresAt: "2026-10-04T12:00:00.000Z",
    });
    expect(ran).toEqual([]);
  });

  it("lets only a teacher of the offering approve a grade, over http, and then applies it once as the requester", async () => {
    const { runner, ran, audit } = queueFor();
    const id = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara")));

    // No tool or agent channel can approve, not even the teacher's own agent.
    for (const channel of ["agent", "mcp-tool"] as const) {
      expect(errorCode(await runner.approve({ principal: P.morgan, channel }, id))).toBe("forbidden");
    }
    // A student, and a teacher of another class, cannot see the request at all.
    expect(errorCode(await runner.approve(person(P.amara), id))).toBe("not-found");
    expect(errorCode(await runner.approve(person(P.rivera), id))).toBe("not-found");
    expect(ran).toEqual([]);

    const approved = await runner.approve(person(P.morgan), id);
    expect(approved).toMatchObject({ status: "applied", approvalId: id, value: { recorded: 91 } });
    expect(audit.events.filter((e) => e.correlationId === (approved as { correlationId: string }).correlationId).at(-1))
      .toMatchObject({ principalId: P.morgan.principalId, action: "approve", channel: "http", effect: "allow", ruleId: "grade.official.teacher-direct" });
    expect(ran).toHaveLength(1);
    expect(ran[0]!.context).toMatchObject({ principal: P.morgan, channel: "agent" });

    // A retried approval answers already-applied and runs nothing.
    expect(await runner.approve(person(P.morgan), id)).toMatchObject({ status: "already-applied", approvalId: id });
    expect(ran).toHaveLength(1);
  });

  it("holds a co-teacher's agent grade for the teacher: the co-teacher cannot approve it", async () => {
    const { runner, ran } = queueFor();
    const id = approvalIdOf(await runner.invoke(agent(P.chen), "record_grade", gradeFor(ENG9, "prn_nf-student-chidi")));
    expect(await runner.approve(person(P.chen), id)).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(ran).toEqual([]);
    expect(await runner.approve(person(P.rivera), id)).toMatchObject({ status: "applied" });
    expect(ran.map((r) => r.context.principal)).toEqual([P.chen]);
  });

  it("is idempotent: the same open call queues once, and a different one queues separately", async () => {
    const { runner, store } = queueFor();
    const first = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara")));
    // The same input in another key order is the same call.
    const again = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", { score: 91, studentId: "prn_nf-student-amara", offeringId: BIO }));
    const other = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara", 70)));
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(await store.list()).toHaveLength(2);

    // Once decided, the same call queues afresh.
    await runner.approve(person(P.morgan), first);
    const later = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara")));
    expect(later).not.toBe(first);
  });

  it("expires: an old request can no longer be approved, and an identical call queues afresh", async () => {
    const { runner, store, ran, clock } = queueFor();
    const id = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara")));
    clock.advance(3 * DAY);
    expect(await runner.approve(person(P.morgan), id)).toMatchObject({ status: "error", error: { code: "conflict", message: "This request has expired." } });
    expect((await store.get(id))!.state).toBe("expired");
    expect(ran).toEqual([]);

    const renewed = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara")));
    expect(renewed).not.toBe(id);
    clock.advance(3 * DAY);
    expect(await runner.expireDue()).toBe(1);
    expect((await store.get(renewed))!.state).toBe("expired");
  });

  it("declines with a reason, after which nothing can approve it", async () => {
    const { runner, store, ran } = queueFor();
    const id = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara")));
    expect(await runner.decline(person(P.morgan), id, "")).toMatchObject({ status: "error", error: { code: "validation-failed" } });
    expect(await runner.decline(person(P.amara), id, "I don't like it")).toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(await runner.decline({ principal: P.morgan, channel: "agent" }, id, "Agent declines")).toMatchObject({ status: "error", error: { code: "forbidden" } });

    expect(await runner.decline(person(P.morgan), id, "Wrong rubric")).toMatchObject({ status: "declined", approvalId: id });
    expect(await store.get(id)).toMatchObject({ state: "declined", decidedBy: P.morgan.principalId, declineReason: "Wrong rubric" });
    expect(await runner.approve(person(P.morgan), id)).toMatchObject({ status: "error", error: { code: "conflict" } });
    expect(ran).toEqual([]);
  });

  it("with confirmWrites, queues an agent's allowed write for the requester to confirm, and still runs reads", async () => {
    const { runner, ran, artifacts } = queueFor();
    expect(await runner.invoke(agent(P.amara), "read_artifact", { artifactId: "art_amara-lab" }, { confirmWrites: true }))
      .toMatchObject({ status: "ok", value: "v1" });

    const outcome = await runner.invoke(agent(P.amara), "edit_artifact", { artifactId: "art_amara-lab", text: "v2" }, { confirmWrites: true });
    expect(outcome).toMatchObject({ status: "approval-required", needs: "confirmation" });
    expect(artifacts.get("art_amara-lab")!.text).toBe("v1");

    const id = approvalIdOf(outcome);
    // Her teacher cannot confirm her agent's change for her, and her agent cannot confirm it.
    expect(errorCode(await runner.approve(person(P.morgan), id))).toBe("not-found");
    expect(errorCode(await runner.approve(agent(P.amara), id))).toBe("forbidden");
    expect(await runner.approve(person(P.amara), id)).toMatchObject({ status: "applied" });
    expect(artifacts.get("art_amara-lab")!.text).toBe("v2");
    expect(ran.map((r) => r.tool)).toEqual(["edit_artifact"]);
  });

  it("does not queue a refused write: the refusal is answered at once", async () => {
    const { runner, store } = queueFor();
    const outcome = await runner.invoke(agent(P.elena), "edit_artifact", { artifactId: "art_amara-lab", text: "x" }, { confirmWrites: true });
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(await store.list()).toEqual([]);
  });

  it("decides the requester's call again before applying it: a change they may no longer make is declined", async () => {
    const { runner, store, directory, artifacts } = queueFor();
    const id = approvalIdOf(await runner.invoke(agent(P.amara), "edit_artifact", { artifactId: "art_amara-lab", text: "v2" }, { confirmWrites: true }));
    const { snapshot, version } = await directory.load();
    snapshot.enrollments.find((e) => e.id === "enr_nf-02")!.status = "inactive";
    await directory.commit(snapshot, version);

    expect(await runner.approve(person(P.amara), id)).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(await store.get(id)).toMatchObject({ state: "declined", declineReason: "The change is no longer permitted." });
    expect(artifacts.get("art_amara-lab")!.text).toBe("v1");
  });

  it("returns an action whose handler fails to pending, so it can be approved again", async () => {
    const { runner, store, ran, failOnce } = queueFor();
    const id = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara")));
    failOnce();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await runner.approve(person(P.morgan), id);
    error.mockRestore();
    expect(failed).toMatchObject({ status: "error", error: { code: "unavailable" } });
    expect(JSON.stringify(failed)).not.toContain("gradebook");
    expect((await store.get(id))!.state).toBe("pending");
    expect(await runner.approve(person(P.morgan), id)).toMatchObject({ status: "applied" });
    expect(ran).toHaveLength(1);
  });

  it("runs an action once when two approvals race", async () => {
    const { runner, ran } = queueFor();
    const id = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara")));
    const outcomes = await Promise.all([runner.approve(person(P.morgan), id), runner.approve(person(P.morgan), id)]);
    expect(outcomes.filter((o) => o.status === "applied")).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });

  it("lists to each person only the requests they made or may approve", async () => {
    const { runner } = queueFor();
    const bio = approvalIdOf(await runner.invoke(agent(P.morgan), "record_grade", gradeFor(BIO, "prn_nf-student-amara")));
    const eng = approvalIdOf(await runner.invoke(agent(P.chen), "record_grade", gradeFor(ENG9, "prn_nf-student-chidi")));
    const ids = async (who: typeof P.amara) => (await runner.pendingFor(person(who))).map((a) => a.id);
    expect(await ids(P.morgan)).toEqual([bio]);
    expect(await ids(P.rivera)).toEqual([eng]);
    expect(await ids(P.chen)).toEqual([eng]);
    expect(await ids(P.amara)).toEqual([]);
  });

  it("answers not-found for an ID that is malformed or was never issued", async () => {
    const { runner } = queueFor();
    for (const id of ["apr_missing", "../etc", 42, undefined]) {
      expect(errorCode(await runner.approve(person(P.morgan), id))).toBe("not-found");
    }
  });

  it("refuses confirmWrites without a queue", async () => {
    const { engine } = engineFor();
    const runner = new SchoolToolRunner({ tools: [], engine });
    await expect(runner.invoke(agent(P.amara), "x", {}, { confirmWrites: true })).rejects.toThrow(/approval queue/);
  });
});
