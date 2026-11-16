import { EvidenceContract } from "@educateos/registry";
import { ActivityRequest, type Observation, type StudioCompanionTransport } from "../src/index.ts";

/** Synthetic instructional fixture; no claimed standards alignment or real student data. */
export const instant = "2026-11-15T12:00:00.000Z";
export const now = () => new Date(instant);
export const request = (): ActivityRequest => ActivityRequest.parse({
  runId: crypto.randomUUID(), sessionId: "local-session", adapterId: "roblox-studio-companion",
  actionId: "scenario:pizza-rates@1", operation: "run-scenario",
  scope: { districtId: "demo-district", offeringId: "demo-class", studentId: "demo-learner",
    projectId: "pizza-tycoon", sourceId: "local-place", revision: "reviewed-place-sha256-v1" },
  contract: EvidenceContract.parse({
    id: "evc_pizza-rates", version: 1, title: "Explain pizza production rates", competencies: [],
    responseType: "text", criteria: [{ id: "explain-rate", description: "Explain pizzas per minute and solve a fresh independent rate problem." }],
    restrictions: { aiAssistance: "allowed-with-disclosure", collaboration: "individual" },
    provenance: { source: "district-authored", sourceUri: "urn:educateos:activity-adapters:fixture", sourceRevision: "1", retrievedAt: instant },
  }),
  requiredSurfaces: ["server", "client", "test"], assistance: ["ai"],
});
export const observation = (r: ActivityRequest, surface: Observation["surface"]): Observation => ({
  surface, sourceId: r.scope.sourceId, revision: r.scope.revision, observedAt: instant,
  status: "observed", code: "ok", artifacts: [],
  measurements: [{ name: "scenario-completed", value: true, unit: "boolean" }],
});
/** Deliberately lacks a client probe. Recording calls makes unintended driving visible in tests. */
export function fakeCompanion(r: ActivityRequest) {
  const calls: { method: string; input: unknown }[] = [];
  const transport: StudioCompanionTransport = {
    async observe(input) { calls.push({ method: "observe", input }); return [observation(r, "editor")]; },
    async collect(input) { calls.push({ method: "collect", input }); return [observation(r, "server")]; },
    async runPluginScenario(input) {
      calls.push({ method: "runPluginScenario", input });
      return [
        { ...observation(r, "server"), measurements: [{ name: "pizzas-produced", value: 80, unit: "count" }] },
        observation(r, "test"),
      ];
    },
  };
  return { transport, calls };
}
