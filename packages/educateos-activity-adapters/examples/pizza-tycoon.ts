import { ActivityRuntime, MemoryReplayStore, acceptEvidence, sessionAuthority, studioAdapter } from "../src/index.ts";
import { fakeCompanion, instant, now, request } from "./fixture.ts";

const run = request();
const fake = fakeCompanion(run);
const authority = sessionAuthority({
  consent: { sessionId: run.sessionId, actorId: "demo-user", decisionId: "fixture-session-consent",
    scope: run.scope, issuedAt: instant, expiresAt: "2026-11-15T12:30:00.000Z",
    actions: [{ adapterId: run.adapterId, actionId: run.actionId, operation: run.operation }] },
  now, allowed: async () => true, // Fixture only: production host checks roster, ownership and catalog approvals.
  approveSideEffect: async (_request, digest) => {
    console.log("SIMULATED user approval of this exact action:", digest);
    return "fixture-user-approved-this-run";
  },
});
const runtime = new ActivityRuntime({ authority, replay: new MemoryReplayStore(), producerId: "fake-local-companion", now });
runtime.register(studioAdapter({ binding: { sessionId: run.sessionId, studioId: "fixture-studio", scope: run.scope },
  transport: fake.transport, scenarios: [{ id: "pizza-rates", revision: "1", clients: 2 }], now }));
const evidence = await runtime.run(run);
// Fixture models an authenticated receipt delivered separately by the trusted companion.
const receivedDigest = evidence.digest;
await acceptEvidence(JSON.parse(JSON.stringify(evidence)), run, {
  authenticate: async (candidate) => candidate.digest === receivedDigest,
  replay: new MemoryReplayStore(),
});
console.log(JSON.stringify({ calls: fake.calls, evidence }, null, 2));
console.log("Client surface unavailable => partial coverage. 80 pizzas is project behavior, not learner mastery.");
console.log("Ask the learner to explain units and solve a fresh independent problem, then use teacher review.");
