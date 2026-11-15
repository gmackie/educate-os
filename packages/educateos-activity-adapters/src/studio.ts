import { z } from "zod";
import { ActivityScope, Id, type ActivityRequest, type Observation } from "./contracts.ts";
import { missingObservation, type LearningActivityAdapter } from "./runtime.ts";

/** Exact session binding, established interactively by the user in their trusted local companion. */
export const StudioBinding = z.strictObject({
  sessionId: Id, studioId: Id, scope: ActivityScope,
});
/** A binding never contains a Roblox cookie, API key or school-service credential. */
export type StudioBinding = z.infer<typeof StudioBinding>;
/**
 * Companion protocol, NOT Roblox MCP's wire-response format. The local companion translates the
 * installed official tools/list schema and normalizes responses to Observation[]. It must verify
 * this binding and its own per-session consent before using its local stdio connection.
 */
export interface StudioCompanionTransport {
  /** Pure read: only the named official tool, no execute_luau or hidden play-mode transition. */
  observe(input: { binding: StudioBinding; studio_id: string; tool: "get_studio_state"; runId: string }): Promise<unknown>;
  /** Opt-in structured instrument evidence; do not sweep get_console_output/private chat. */
  collect(input: { binding: StudioBinding; studio_id: string; runId: string }): Promise<unknown>;
  /**
   * A companion/plugin command, NOT an official MCP tool. The installed, user-reviewed plugin
   * calls StudioTestService.ExecuteMultiplayerTestAsync (1–8 clients) in plugin context. Only
   * one test per Studio instance; reject concurrent/busy sessions. No arbitrary Luau argument.
   */
  runPluginScenario?(input: { binding: StudioBinding; studio_id: string; runId: string;
    scenarioId: string; scenarioRevision: string; clients: number }): Promise<unknown>;
}
/** A host-installed scenario identifies reviewed code; students cannot submit script text. */
export const StudioScenario = z.strictObject({ id: Id, revision: Id, clients: z.number().int().min(1).max(8) });
/**
 * Optional Roblox/LevelForge bridge. Runs where the injected trusted companion is reachable;
 * it neither spawns Studio nor assumes a remote Cloudflare Worker can access local stdio.
 * Mutations, execute_luau, multi_edit, save_place and open_cloud_invoke are deliberately absent.
 */
export function studioAdapter(options: {
  binding: StudioBinding; transport?: StudioCompanionTransport;
  scenarios?: z.infer<typeof StudioScenario>[]; now?: () => Date;
}): LearningActivityAdapter {
  const binding = StudioBinding.parse(options.binding);
  const scenarios = z.array(StudioScenario).max(32).parse(options.scenarios ?? []);
  if (new Set(scenarios.map((s) => s.id)).size !== scenarios.length) throw new Error("Duplicate scenario");
  const transport = options.transport;
  const now = options.now ?? (() => new Date());
  const matches = (request: ActivityRequest) => request.sessionId === binding.sessionId
    && Object.keys(binding.scope).every((key) => binding.scope[key as keyof ActivityScope] === request.scope[key as keyof ActivityScope]);
  return {
    descriptor: { id: "roblox-studio-companion", version: "1", actions: [
      { id: "studio-state", operation: "observe", surfaces: ["editor"] },
      { id: "instrument-evidence", operation: "collect-evidence", surfaces: ["editor", "server", "client", "test"] },
      ...scenarios.map((scenario) => ({ id: `scenario:${scenario.id}@${scenario.revision}`,
        operation: "run-scenario" as const, surfaces: ["server", "client", "test"] as Observation["surface"][] })),
    ] },
    async execute(request) {
      const fail = (status: Observation["status"], code: Observation["code"]) => request.requiredSurfaces
        .map((surface) => missingObservation(request, surface, status, code, now().toISOString()));
      if (!matches(request)) return fail("error", "source-mismatch");
      if (!transport) return fail("unavailable", "not-connected");
      const input = { binding: structuredClone(binding), studio_id: binding.studioId, runId: request.runId };
      try {
        if (request.operation === "observe" && request.actionId === "studio-state") {
          return await transport.observe({ ...input, tool: "get_studio_state" });
        }
        if (request.operation === "collect-evidence" && request.actionId === "instrument-evidence") return await transport.collect(input);
        const scenario = scenarios.find((s) => request.actionId === `scenario:${s.id}@${s.revision}`);
        if (request.operation !== "run-scenario" || !scenario || !transport.runPluginScenario) return fail("unsupported", "not-supported");
        return await transport.runPluginScenario({ ...input, scenarioId: scenario.id, scenarioRevision: scenario.revision, clients: scenario.clients });
      } catch { return fail("error", "transport-failed"); }
    },
  };
}
