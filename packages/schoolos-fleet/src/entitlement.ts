import { CapabilityId, SchoolOsError } from "@schoolos/contracts";
import { z } from "zod";
import { parseWire, SignedEnvelope, verifyEnvelope } from "./envelope.ts";
import type { Ed25519PublicKey } from "./identity.ts";
import { InstanceId } from "./ids.ts";
import { Sequence, UtcTimestamp } from "./protocol.ts";

/**
 * What the root has entitled an instance to, signed by the root. `revision` only ever increases,
 * so an older entitlement can't be replayed over a newer one. Between `validUntil` and
 * `graceUntil` the entitlement is in its grace period: still honoured, but due for renewal.
 */
export const Entitlement = z
  .strictObject({
    instanceId: InstanceId,
    revision: Sequence,
    capabilityIds: z.array(CapabilityId).max(64),
    issuedAt: UtcTimestamp,
    validUntil: UtcTimestamp,
    graceUntil: UtcTimestamp,
  })
  .refine((e) => Date.parse(e.issuedAt) <= Date.parse(e.validUntil) && Date.parse(e.validUntil) <= Date.parse(e.graceUntil), {
    message: "expected issuedAt <= validUntil <= graceUntil",
  });
/** An entitlement. */
export type Entitlement = z.infer<typeof Entitlement>;

/** Where the district keeps its last accepted entitlement, as the signed envelope the root sent. */
export interface EntitlementStore {
  /** The stored envelope, if any. */
  load(): Promise<SignedEnvelope | undefined>;
  /** Replaces the stored envelope. */
  save(envelope: SignedEnvelope): Promise<void>;
}

/** An {@link EntitlementStore} in memory. For tests and the local harness only. */
export class InMemoryEntitlementStore implements EntitlementStore {
  #envelope: SignedEnvelope | undefined;

  async load(): Promise<SignedEnvelope | undefined> {
    return this.#envelope && structuredClone(this.#envelope);
  }

  async save(envelope: SignedEnvelope): Promise<void> {
    this.#envelope = structuredClone(envelope);
  }
}

/**
 * Where the held entitlement stands: `valid` before `validUntil`, `grace` until `graceUntil`,
 * `lapsed` after, `absent` if the district holds none.
 */
export type EntitlementState = "valid" | "grace" | "lapsed" | "absent";

/**
 * The result of evaluating the held entitlement. It governs only root-managed changes (new
 * releases, new capability packs, support sessions). Classroom features never depend on it
 * (ADR-0001 §3-4), which `classroom` states in the type: there is no other value it can take.
 */
export interface EntitlementEvaluation {
  state: EntitlementState;
  /** Whether the district may apply new root-managed changes. */
  rootManagedChanges: "allowed" | "blocked";
  /** Classroom features (sign-in, lessons, AI requests, grading, budgets) are unaffected by any state. */
  classroom: "unaffected";
  /** The entitled capability packs, empty when `absent`. */
  capabilityIds: CapabilityId[];
  /** When the grace period ends, if an entitlement is held. */
  graceUntil?: string;
}

/** The outcome of {@link EntitlementCache.refresh}. */
export interface EntitlementRefresh {
  outcome: "updated" | "unchanged" | "root-unreachable" | "rejected";
  evaluation: EntitlementEvaluation;
}

/** What an {@link EntitlementCache} needs. */
export interface EntitlementCacheOptions {
  instanceId: InstanceId;
  /** The root's entitlement signing key, pinned in the district's configuration. */
  rootPublicKey: Ed25519PublicKey;
  store: EntitlementStore;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/**
 * The district's copy of its last signed entitlement. Evaluating it reads only local storage and
 * the clock, never the network, so an unreachable root changes nothing until the grace period
 * ends, and even then it stops only new root-managed changes.
 */
export class EntitlementCache {
  readonly #instanceId: InstanceId;
  readonly #rootPublicKey: Ed25519PublicKey;
  readonly #store: EntitlementStore;
  readonly #now: () => Date;

  constructor(options: EntitlementCacheOptions) {
    this.#instanceId = options.instanceId;
    this.#rootPublicKey = options.rootPublicKey;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Verifies and stores an entitlement from the root. It must be signed by the pinned root key,
   * name this instance, and have a higher revision than the one held (`conflict` otherwise).
   */
  async accept(input: unknown): Promise<EntitlementEvaluation> {
    const envelope = parseWire(SignedEnvelope, input, "envelope");
    const entitlement = await this.#open(envelope);
    if (entitlement === undefined) throw new SchoolOsError("unauthenticated", "entitlement not accepted");
    const held = await this.#held();
    if (held !== undefined && entitlement.revision <= held.revision) {
      throw new SchoolOsError("conflict", "entitlement is not newer than the one held");
    }
    await this.#store.save(envelope);
    return this.#evaluate(entitlement);
  }

  /**
   * Asks the root for a newer entitlement through `fetchLatest` and accepts it if it is one. A
   * failing fetch or a rejected entitlement leaves the held one in place.
   */
  async refresh(fetchLatest: () => Promise<unknown>): Promise<EntitlementRefresh> {
    let latest: unknown;
    try {
      latest = await fetchLatest();
    } catch {
      return { outcome: "root-unreachable", evaluation: await this.evaluate() };
    }
    try {
      return { outcome: "updated", evaluation: await this.accept(latest) };
    } catch (error) {
      if (!(error instanceof SchoolOsError)) throw error;
      const outcome = error.code === "conflict" ? "unchanged" : "rejected";
      return { outcome, evaluation: await this.evaluate() };
    }
  }

  /** Evaluates the held entitlement against the clock. Makes no network call. */
  async evaluate(): Promise<EntitlementEvaluation> {
    return this.#evaluate(await this.#held());
  }

  #evaluate(entitlement: Entitlement | undefined): EntitlementEvaluation {
    if (entitlement === undefined) {
      return { state: "absent", rootManagedChanges: "blocked", classroom: "unaffected", capabilityIds: [] };
    }
    const now = this.#now().getTime();
    const state: EntitlementState =
      now < Date.parse(entitlement.validUntil) ? "valid" : now < Date.parse(entitlement.graceUntil) ? "grace" : "lapsed";
    return {
      state,
      rootManagedChanges: state === "lapsed" ? "blocked" : "allowed",
      classroom: "unaffected",
      capabilityIds: entitlement.capabilityIds,
      graceUntil: entitlement.graceUntil,
    };
  }

  // The stored copy is re-verified on every read, so tampering with local storage can't extend an
  // entitlement; a copy that fails is treated as absent.
  async #held(): Promise<Entitlement | undefined> {
    const envelope = await this.#store.load();
    return envelope && (await this.#open(envelope));
  }

  async #open(envelope: SignedEnvelope): Promise<Entitlement | undefined> {
    const parsed = Entitlement.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.instanceId !== this.#instanceId) return undefined;
    return (await verifyEnvelope(envelope, "entitlement", this.#rootPublicKey)) ? parsed.data : undefined;
  }
}
