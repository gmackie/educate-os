import { describe, expect, it, vi } from "vitest";
import { digestJson } from "@educateos/assessment-sdk";
import { ActivityRequest, ActivityRuntime, MemoryReplayStore, SessionConsent, acceptEvidence, gadgetAdapter,
  offlineAdapter, sessionAuthority, studioAdapter, verifyEvidence, verifyWithTeacher,
  type ActivityAuthority, type LearningActivityAdapter, type OfflineSubmission } from "./index.ts";
import { fakeCompanion, instant, now, observation, request } from "../examples/fixture.ts";

const approved: ActivityAuthority = { approve: async () => ({ actorId: "user", decisionId: "trusted-ui" }) };
function runtime(adapter: LearningActivityAdapter, authority = approved, replay = new MemoryReplayStore()) {
  const host = new ActivityRuntime({ authority, replay, producerId: "trusted-host", now });
  host.register(adapter);
  return host;
}
function studio(r = request()) {
  const fake = fakeCompanion(r);
  const adapter = studioAdapter({ binding: { sessionId: r.sessionId, studioId: "chosen-studio", scope: r.scope },
    transport: fake.transport, scenarios: [{ id: "pizza-rates", revision: "1", clients: 2 }], now });
  return { ...fake, adapter, host: runtime(adapter), r };
}
function consent(r = request()) {
  return { sessionId: r.sessionId, actorId: "user", decisionId: "session-read-consent", scope: r.scope,
    issuedAt: instant, expiresAt: "2026-11-15T12:30:00.000Z",
    actions: [{ adapterId: r.adapterId, actionId: r.actionId, operation: r.operation }] };
}

// This suite exercises the real runtime + adapter + fake external local transport together.
describe("local Studio integration", () => {
  it("runs only a reviewed plugin scenario and preserves missing client coverage", async () => {
    const { host, r, calls } = studio();
    const bundle = await host.run(r);
    expect(calls).toEqual([{ method: "runPluginScenario", input: {
      binding: { sessionId: r.sessionId, studioId: "chosen-studio", scope: r.scope }, studio_id: "chosen-studio",
      runId: r.runId, scenarioId: "pizza-rates", scenarioRevision: "1", clients: 2,
    } }]);
    expect(bundle.body.status).toBe("partial");
    expect(bundle.body.observations.find((o) => o.surface === "client")).toMatchObject({ status: "unavailable", code: "missing" });
    expect(bundle.body.learningClaim).toBe("requires-teacher-verification");
    await expect(verifyEvidence(bundle)).resolves.toEqual(bundle);
  });
  it("observing only calls get_studio_state, never starts play or evaluates Luau", async () => {
    const r = request(); Object.assign(r, { operation: "observe", actionId: "studio-state", requiredSurfaces: ["editor"] });
    const { host, calls } = studio(r);
    expect((await host.run(r)).body.status).toBe("complete");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "observe", input: { tool: "get_studio_state", studio_id: "chosen-studio" } });
  });
  it("collecting calls only opt-in instruments", async () => {
    const r = request(); Object.assign(r, { operation: "collect-evidence", actionId: "instrument-evidence" });
    const { host, calls } = studio(r);
    await host.run(r);
    expect(calls.map((c) => c.method)).toEqual(["collect"]);
  });
  it.each(["execute_luau", "multi_edit", "save_place", "open_cloud_invoke", "scenario:unreviewed@1"])("refuses %s without transport calls", async (actionId) => {
    const { host, calls, r } = studio(); r.actionId = actionId;
    expect((await host.run(r)).body.status).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });
  it("rejects arbitrary script, approval flags and private chat fields at the input boundary", async () => {
    const { host, calls, r } = studio();
    for (const extra of [{ script: "print('unsafe')" }, { approved: true }, { privateChat: "private" }]) {
      await expect(host.run({ ...r, ...extra })).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });
  it("refuses cross-session or cross-project binding", async () => {
    const { host, calls, r } = studio(); r.sessionId = "another-session";
    expect((await host.run(r)).body.observations[0].code).toBe("source-mismatch");
    r.runId = crypto.randomUUID(); r.scope.projectId = "third-party-game";
    expect((await host.run(r)).body.status).toBe("error");
    expect(calls).toHaveLength(0);
  });
  it("reports a disconnected companion honestly", async () => {
    const r = request();
    const host = runtime(studioAdapter({ binding: { sessionId: r.sessionId, studioId: "s", scope: r.scope },
      scenarios: [{ id: "pizza-rates", revision: "1", clients: 2 }], now }));
    expect((await host.run(r)).body.status).toBe("unavailable");
  });
  it("does not pretend an absent plugin can run StudioTestService", async () => {
    const r = request();
    const fake = fakeCompanion(r); delete fake.transport.runPluginScenario;
    const host = runtime(studioAdapter({ binding: { sessionId: r.sessionId, studioId: "s", scope: r.scope },
      transport: fake.transport, scenarios: [{ id: "pizza-rates", revision: "1", clients: 8 }], now }));
    expect((await host.run(r)).body.status).toBe("unsupported");
  });
  it("rejects more than eight StudioTestService clients", () => {
    const r = request();
    expect(() => studioAdapter({ binding: { sessionId: r.sessionId, studioId: "s", scope: r.scope },
      scenarios: [{ id: "bad", revision: "1", clients: 9 }] })).toThrow();
  });
  it("sanitizes transport exceptions and refuses a replay even after uncertain failure", async () => {
    const { adapter, transport, r, calls } = studio();
    transport.runPluginScenario = async () => { calls.push({ method: "attempt", input: null }); throw new Error("secret-token private-chat"); };
    const host = runtime(adapter);
    const result = await host.run(r);
    expect(result.body.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect((await host.run(r)).body.status).toBe("replay");
    expect(calls).toHaveLength(1);
  });
});

describe("bounded default-deny consent", () => {
  it("default denies and never calls a side-effect transport", async () => {
    const { adapter, r, calls } = studio();
    expect((await runtime(adapter, sessionAuthority()).run(r)).body.status).toBe("denied");
    expect(calls).toHaveLength(0);
  });
  it("read consent cannot authorize scenarios, and scope/action/operation must all match", async () => {
    const r = request();
    const c = consent(r); c.actions[0].operation = "observe";
    const policy = sessionAuthority({ consent: c, allowed: async () => true, now, approveSideEffect: async () => "yes" });
    expect(await policy.approve(r, "digest")).toBeNull();
    expect(await sessionAuthority({ consent: consent(r), now }).approve(r, "digest")).toBeNull();
    expect(await sessionAuthority({ consent: consent(r), allowed: async () => true, now }).approve(r, "digest")).toBeNull();
  });
  it("asks fresh approval for every run and binds it to the exact digest", async () => {
    const { adapter, r, calls } = studio();
    const confirm = vi.fn(async () => "clicked-approve");
    const policy = sessionAuthority({ consent: consent(r), allowed: async () => true, approveSideEffect: confirm, now });
    const host = runtime(adapter, policy);
    const first = await host.run(r);
    r.runId = crypto.randomUUID(); await host.run(r);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0]).toEqual([first.body.request, first.body.requestDigest]);
    expect(calls).toHaveLength(2);
    policy.revoke(); r.runId = crypto.randomUUID();
    expect((await host.run(r)).body.status).toBe("denied");
    expect(calls).toHaveLength(2);
  });
  it("expires during an approval dialog, and bounds session duration", async () => {
    const r = request(); let time = now();
    const policy = sessionAuthority({ consent: consent(r), allowed: async () => true, now: () => time,
      approveSideEffect: async () => { time = new Date("2026-11-15T13:00:00.000Z"); return "late-yes"; } });
    expect(await policy.approve(r, "digest")).toBeNull();
    expect(SessionConsent.safeParse({ ...consent(r), expiresAt: "2026-11-16T12:00:00.000Z" }).success).toBe(false);
  });
  it("gates a generic mutation as strictly as a scenario", async () => {
    const r = request(); r.operation = "mutate"; r.actionId = "reviewed-edit"; r.requiredSurfaces = ["source"];
    const execute = vi.fn(async () => [observation(r, "source")]);
    const adapter: LearningActivityAdapter = { descriptor: { id: r.adapterId, version: "1",
      actions: [{ id: r.actionId, operation: "mutate", surfaces: ["source"] }] }, execute };
    const denied = sessionAuthority({ consent: consent(r), allowed: async () => true, now });
    expect((await runtime(adapter, denied).run(r)).body.status).toBe("denied");
    expect(execute).not.toHaveBeenCalled();
    const allowed = sessionAuthority({ consent: consent(r), allowed: async () => true, now, approveSideEffect: async () => "explicit-edit-approval" });
    expect((await runtime(adapter, allowed).run(r)).body.status).toBe("complete");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("verifiable evidence", () => {
  it("rejects tampering, forged provenance with a recomputed digest, and duplicate ingestion", async () => {
    const { host, r } = studio(); const bundle = await host.run(r);
    const inbox = { authenticate: async (b: { digest: string }) => b.digest === bundle.digest, replay: new MemoryReplayStore() };
    const altered = structuredClone(bundle); altered.body.producerId = "forged-host";
    await expect(verifyEvidence(altered)).rejects.toThrow("digest");
    altered.digest = await digestJson(altered.body);
    await expect(acceptEvidence(altered, r, inbox)).rejects.toThrow("Unauthenticated");
    await expect(acceptEvidence(bundle, { ...r, sessionId: "another-session" }, inbox)).rejects.toThrow("Unexpected");
    await acceptEvidence(bundle, r, inbox);
    await expect(acceptEvidence(bundle, r, inbox)).rejects.toThrow("replay");
  });
  it("concurrent run replay invokes the transport only once", async () => {
    const { host, r, calls } = studio();
    const results = await Promise.all([host.run(r), host.run(r)]);
    expect(results.map((b) => b.body.status).toSorted()).toEqual(["partial", "replay"]);
    expect(calls).toHaveLength(1);
  });
  it.each(["empty", "duplicate", "stale", "revision", "private-chat"])("never silently passes %s observations", async (mode) => {
    const r = request(); const o = observation(r, "server");
    let result: unknown = [];
    if (mode === "duplicate") result = [o, o];
    if (mode === "stale") result = [{ ...o, observedAt: "2026-01-01T00:00:00.000Z" }];
    if (mode === "revision") result = [{ ...o, revision: "wrong-revision" }];
    if (mode === "private-chat") result = [{ ...o, chat: "never import" }];
    const adapter: LearningActivityAdapter = { descriptor: { id: r.adapterId, version: "1",
      actions: [{ id: r.actionId, operation: r.operation, surfaces: ["server", "client", "test"] }] }, execute: async () => result };
    const b = await runtime(adapter).run(r);
    expect(["error", "unavailable"]).toContain(b.body.status);
    await verifyEvidence(b);
    expect(JSON.stringify(b)).not.toContain("never import");
  });
  it("does not equate observed failed tests with success", async () => {
    const r = request(); r.requiredSurfaces = ["test"];
    const o = observation(r, "test"); o.measurements[0].value = false;
    const adapter: LearningActivityAdapter = { descriptor: { id: r.adapterId, version: "1",
      actions: [{ id: r.actionId, operation: r.operation, surfaces: ["test"] }] }, execute: async () => [o] };
    const b = await runtime(adapter).run(r);
    expect(b.body.status).toBe("complete");
    expect(b.body.observations[0].measurements[0].value).toBe(false);
    expect(b.body.learningClaim).toBe("requires-teacher-verification");
  });
  it("rejects duplicate adapter registration and contradictory assistance", () => {
    const { host, adapter, r } = studio();
    expect(() => host.register(adapter)).toThrow("already registered");
    expect(ActivityRequest.safeParse({ ...r, assistance: ["independent", "ai"] }).success).toBe(false);
  });
});

describe("supported Gadget source API", () => {
  function gadgetRequest() {
    const r = request(); r.adapterId = "educateos-gadget"; r.operation = "observe";
    r.actionId = "selected-source"; r.requiredSurfaces = ["source"]; r.scope.revision = "a".repeat(40);
    return r;
  }
  it("reads only selected files at the pinned commit and hashes without executing/copying content", async () => {
    const r = gadgetRequest();
    const readFilesAtCommit = vi.fn(async () => [["main.ts", { kind: "text" as const, text: "throw new Error('do not execute');" }] as [string, { kind: "text"; text: string }]]);
    const b = await runtime(gadgetAdapter({ scope: r.scope, paths: ["main.ts"], source: { readFilesAtCommit }, now })).run(r);
    expect(readFilesAtCommit).toHaveBeenCalledWith(r.scope.revision, ["main.ts"]);
    expect(b.body.status).toBe("complete");
    expect(JSON.stringify(b)).not.toContain("do not execute");
    expect(b.body.observations[0].artifacts[0].digest).toMatch(/^sha256:/);
  });
  it("missing response entries are not absent files or successful empty evidence", async () => {
    const r = gadgetRequest();
    const b = await runtime(gadgetAdapter({ scope: r.scope, paths: ["main.ts"], source: { readFilesAtCommit: async () => [] }, now })).run(r);
    expect(b.body.status).toBe("unavailable");
  });
  it("cancels returned streams even when another requested file is absent", async () => {
    const r = gadgetRequest(); const cancel = vi.fn();
    const source = { readFilesAtCommit: async () => [["main.ts", { kind: "absent" as const }],
      ["large.ts", { kind: "stream" as const, byteLength: 20_000_000, content: new ReadableStream<Uint8Array>({ cancel }) }]] as Awaited<ReturnType<import("./gadget.ts").GadgetSource["readFilesAtCommit"]>> };
    const b = await runtime(gadgetAdapter({ scope: r.scope, paths: ["main.ts", "large.ts"], source, now })).run(r);
    expect(b.body.status).toBe("unavailable"); expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("offline work and teacher verification", () => {
  async function submitted() {
    const r = request(); Object.assign(r, { adapterId: "offline-activity", operation: "collect-evidence", actionId: "shared-submission", requiredSurfaces: ["physical"] });
    const submission: OfflineSubmission = { id: "baking-sheet", sessionId: r.sessionId, scope: r.scope,
      domain: "baking", performedAt: "2026-11-14T12:00:00.000Z", explanation: "I compared cost per cookie; AI helped with the first calculation.",
      assistance: ["ai"], measurements: [{ name: "cookies", value: 20, unit: "count" }], artifacts: [], explicitlyShared: true };
    const bundle = await runtime(offlineAdapter(submission, now)).run(r);
    return { r, submission, bundle };
  }
  it("pins the entire voluntary submission including original time and disclosed help", async () => {
    const { bundle, submission } = await submitted();
    expect(bundle.body.observations[0].artifacts[0].digest).toBe(await digestJson(submission));
    expect(bundle.body.request.assistance).toEqual(["ai"]);
    expect(bundle.body.learningClaim).toBe("requires-teacher-verification");
  });
  it("requires explicit sharing and cannot silently relabel AI work as independent", async () => {
    const { r, submission } = await submitted();
    expect(() => offlineAdapter({ ...submission, explicitlyShared: false })).toThrow();
    r.assistance = ["independent"];
    expect((await runtime(offlineAdapter(submission, now)).run(r)).body.status).toBe("error");
  });
  it("refuses verification from artifact success/photos/AI outputs alone", async () => {
    const { bundle } = await submitted();
    await expect(verifyWithTeacher(bundle, { evidenceDigest: bundle.digest, decision: "verify", basis: "artifact-only",
      assistance: ["independent"], rationale: "The cookies/game look good." }, { authorize: async () => ({ teacherId: "teacher" }) }, now)).rejects.toThrow("alone");
  });
  it("requires an authorized teacher, exact bundle and independent criterion assessment; never changes proficiency", async () => {
    const { bundle } = await submitted();
    const review = { evidenceDigest: bundle.digest, decision: "verify", basis: "independent-assessment", assistance: ["independent"],
      rationale: "Student explained units and solved a new ratio independently.", assessment: { responseDigest: await digestJson("fresh student explanation"),
        assessedAt: instant, context: "Fresh unit-price problem in a teacher conference", criteria: [{ id: "explain-rate", met: true }] } };
    await expect(verifyWithTeacher(bundle, review, { authorize: async () => null }, now)).rejects.toThrow("unauthorized");
    const teacher = { authorize: async () => ({ teacherId: "active-class-teacher" }) };
    const record = await verifyWithTeacher(bundle, review, teacher, now);
    expect(record.changesProficiency).toBe(false);
    expect(record.learningClaim).toBe("requires-planner-review");
    expect(bundle.body.request.assistance).toEqual(["ai"]);
    await expect(verifyWithTeacher(bundle, { ...review, assistance: ["ai"] }, teacher, now)).rejects.toThrow();
    await expect(verifyWithTeacher(bundle, { ...review, assessment: { ...review.assessment, criteria: [{ id: "invented", met: true }] } }, teacher, now)).rejects.toThrow("criterion");
    await expect(verifyWithTeacher(bundle, { ...review, evidenceDigest: await digestJson("another") }, teacher, now)).rejects.toThrow("mismatch");
  });
});
