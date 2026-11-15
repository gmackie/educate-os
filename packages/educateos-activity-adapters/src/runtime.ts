import { digestJson, freezeJson } from "@educateos/assessment-sdk";
import { z } from "zod";
import { ActivityRequest, EvidenceBundle, Id, Observation, Operation, Surface } from "./contracts.ts";

const Descriptor = z.strictObject({
  id: Id, version: Id,
  actions: z.array(z.strictObject({ id: Id, operation: Operation, surfaces: z.array(Surface).min(1).max(6) })).min(1),
}).refine((d) => new Set(d.actions.map((a) => a.id)).size === d.actions.length);

/** Installed trusted code only. Registration is not exposed as a student API. */
export interface LearningActivityAdapter {
  descriptor: z.infer<typeof Descriptor>;
  execute(request: ActivityRequest): Promise<unknown>;
}
/** Shared durable implementations must atomically claim keys across requests/restarts. */
export interface ReplayStore {
  claim(key: string): Promise<boolean>;
}
/** Fixture/local-process store. Production ingestion needs a durable unique-key transaction. */
export class MemoryReplayStore implements ReplayStore {
  readonly #seen = new Set<string>();
  async claim(key: string): Promise<boolean> {
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    return true;
  }
}
/** Host policy receives the exact immutable request, including its action and source revision. */
export interface ActivityAuthority {
  /**
   * Verify session, ownership, district policy and current contract approval on EVERY call.
   * Observe/collect may use explicit session read consent. Run/mutate must display and obtain
   * fresh user approval for this exact run/action. Never accept a student-supplied boolean.
   */
  approve(request: ActivityRequest, requestDigest: string): Promise<{ actorId: string; decisionId: string } | null>;
}
/** Produce an explicit non-observation, with no copied upstream exception or response body. */
export function missingObservation(request: ActivityRequest, surface: Observation["surface"],
  status: Observation["status"], code: Observation["code"], at: string): Observation {
  return { surface, sourceId: request.scope.sourceId, revision: request.scope.revision,
    observedAt: at, status, code, measurements: [], artifacts: [] };
}
/** Coverage summary; a measured false assertion still counts as an observed surface. */
export function coverage(observations: Observation[]): "complete" | "partial" | "unavailable" | "unsupported" | "error" {
  if (observations.every((o) => o.status === "observed")) return "complete";
  if (observations.some((o) => o.status === "observed")) return "partial";
  if (observations.some((o) => o.status === "error")) return "error";
  if (observations.every((o) => o.status === "unsupported")) return "unsupported";
  return "unavailable";
}
/** Host-owned adapter registry. It never discovers or downloads executable adapters from a student. */
export class ActivityRuntime {
  readonly #adapters = new Map<string, LearningActivityAdapter>();
  readonly #authority: ActivityAuthority;
  readonly #replay: ReplayStore;
  readonly #producerId: string;
  readonly #now: () => Date;
  constructor(options: { authority: ActivityAuthority; replay: ReplayStore; producerId: string; now?: () => Date }) {
    this.#authority = options.authority; this.#replay = options.replay;
    this.#producerId = Id.parse(options.producerId); this.#now = options.now ?? (() => new Date());
  }
  register(adapter: LearningActivityAdapter): void {
    const descriptor = freezeJson(Descriptor.parse(adapter.descriptor));
    if (this.#adapters.has(descriptor.id)) throw new Error("Adapter already registered");
    // Copy metadata and capture the function so later caller edits cannot change capability checks.
    this.#adapters.set(descriptor.id, { descriptor, execute: adapter.execute.bind(adapter) });
  }
  capabilities(): z.infer<typeof Descriptor>[] {
    return structuredClone([...this.#adapters.values()].map((adapter) => adapter.descriptor));
  }
  async run(raw: unknown): Promise<EvidenceBundle> {
    const request = freezeJson(ActivityRequest.parse(raw));
    const requestDigest = await digestJson(request);
    const startedAt = this.#now().toISOString();
    const adapter = this.#adapters.get(request.adapterId);
    let approval: EvidenceBundle["body"]["approval"] = null;
    const finish = async (observations: Observation[], status: EvidenceBundle["body"]["status"] = coverage(observations)): Promise<EvidenceBundle> => {
      const body = { format: "educateos.activity-evidence.v1" as const, request, requestDigest,
        adapterVersion: adapter?.descriptor.version ?? "unregistered", producerId: this.#producerId,
        startedAt, completedAt: this.#now().toISOString(), approval, status, observations,
        learningClaim: "requires-teacher-verification" as const };
      return freezeJson(EvidenceBundle.parse({ body, digest: await digestJson(body) }));
    };
    const refuse = (status: "unsupported" | "denied" | "replay" | "error", code: Observation["code"]) =>
      finish(request.requiredSurfaces.map((surface) => missingObservation(request, surface,
        status === "unsupported" ? "unsupported" : "error", code, startedAt)), status);
    const action = adapter?.descriptor.actions.find((a) => a.id === request.actionId && a.operation === request.operation);
    if (!adapter || !action) return refuse("unsupported", "not-supported");
    try { approval = await this.#authority.approve(request, requestDigest); }
    catch { return refuse("denied", "denied"); }
    if (!approval || !Id.safeParse(approval.actorId).success || !Id.safeParse(approval.decisionId).success) {
      approval = null;
      return refuse("denied", "denied");
    }
    approval = freezeJson({ ...approval });
    // Claim before invoking any adapter, including after ambiguous failures. No automatic retries.
    try {
      const key = await digestJson(["activity-run", request.scope.districtId, request.runId]);
      if (!await this.#replay.claim(key)) return refuse("replay", "replay");
    } catch { return refuse("error", "transport-failed"); }
    let observations: Observation[];
    try {
      observations = z.array(Observation).max(6).parse(await adapter.execute(request));
      if (new Set(observations.map((o) => o.surface)).size !== observations.length) throw new Error("Duplicate surface");
    } catch {
      return refuse("error", "invalid-response");
    }
    const completedAt = this.#now().getTime();
    return finish(request.requiredSurfaces.map((surface) => {
      if (!action.surfaces.includes(surface)) return missingObservation(request, surface, "unsupported", "not-supported", startedAt);
      const observation = observations.find((o) => o.surface === surface);
      if (!observation) return missingObservation(request, surface, "unavailable", "missing", startedAt);
      if (observation.sourceId !== request.scope.sourceId || observation.revision !== request.scope.revision) {
        return missingObservation(request, surface, "error", "source-mismatch", startedAt);
      }
      const time = Date.parse(observation.observedAt);
      if (time < Date.parse(startedAt) || time > completedAt) {
        return missingObservation(request, surface, "error", "stale", startedAt);
      }
      return observation;
    }));
  }
}
