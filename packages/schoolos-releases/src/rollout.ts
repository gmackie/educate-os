import { InstanceId, OpaqueCode, SchoolOsError, SemVer, UtcTimestamp } from "@schoolos/contracts";
import {
  type InstanceRegistry,
  ReleaseChannel,
  type ReleaseOfferPurpose,
  SignedEnvelope,
} from "@schoolos/fleet";
import { z } from "zod";
import { ReleaseId, ReleaseManifestStatement } from "./manifest.ts";
import type { RootReleaseSigner } from "./signer.ts";

/**
 * Which instances on a channel a rollout offers its release to: a percentage, chosen by a stable
 * hash of the instance and release IDs so each release samples afresh, or a named list.
 */
export const RolloutTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("percentage"), percent: z.number().min(0).max(100) }),
  z.strictObject({ kind: z.literal("instances"), instanceIds: z.array(InstanceId).min(1).max(1000) }),
]);
/** A rollout target. */
export type RolloutTarget = z.infer<typeof RolloutTarget>;

/**
 * When a rollout halts on its own: once more than `maxFailingFraction` of the instances that
 * already run the release report a failing probe in a heartbeat sent since the rollout started.
 */
export const HaltPolicy = z.strictObject({
  maxFailingFraction: z.number().min(0).max(1),
});
/** A halt policy. */
export type HaltPolicy = z.infer<typeof HaltPolicy>;

/** One channel's staged rollout. */
export const Rollout = z.strictObject({
  channel: ReleaseChannel,
  releaseId: ReleaseId,
  version: SemVer,
  target: RolloutTarget,
  status: z.enum(["active", "halted"]),
  startedAt: UtcTimestamp,
  /** The release a halt rolls instances back to: the last rollout on the channel that did not halt. */
  previousReleaseId: ReleaseId.optional(),
  haltedAt: UtcTimestamp.optional(),
  haltReason: OpaqueCode.optional(),
});
/** A rollout. */
export type Rollout = z.infer<typeof Rollout>;

/** A channel's published releases and its current rollout. */
export const ChannelState = z.strictObject({
  /** Signed release manifests published on the channel, by release ID. */
  releases: z.record(ReleaseId, SignedEnvelope),
  rollout: Rollout.optional(),
});
/** A channel's state. */
export type ChannelState = z.infer<typeof ChannelState>;

/** Where the root keeps rollout state. The private root service implements it over its database. */
export interface RolloutStore {
  /** A channel's state; an empty one if nothing was stored. */
  channel(channel: ReleaseChannel): Promise<ChannelState>;
  /** Replaces a channel's state. */
  saveChannel(channel: ReleaseChannel, state: ChannelState): Promise<void>;
  /** The next offer sequence for an instance: greater than any returned before. Must be durable. */
  nextOfferSequence(instanceId: InstanceId): Promise<number>;
}

/** A {@link RolloutStore} in memory. For tests and as the reference for real implementations. */
export class InMemoryRolloutStore implements RolloutStore {
  readonly #channels = new Map<ReleaseChannel, ChannelState>();
  readonly #sequences = new Map<InstanceId, number>();

  async channel(channel: ReleaseChannel): Promise<ChannelState> {
    return structuredClone(this.#channels.get(channel) ?? { releases: {} });
  }

  async saveChannel(channel: ReleaseChannel, state: ChannelState): Promise<void> {
    this.#channels.set(channel, structuredClone(state));
  }

  async nextOfferSequence(instanceId: InstanceId): Promise<number> {
    const next = (this.#sequences.get(instanceId) ?? 0) + 1;
    this.#sequences.set(instanceId, next);
    return next;
  }
}

/** What a {@link RolloutController} needs. */
export interface RolloutControllerOptions {
  /** The root's instance registry: where instances' versions and heartbeat health come from. */
  registry: InstanceRegistry;
  signer: RootReleaseSigner;
  store: RolloutStore;
  haltPolicy: HaltPolicy;
  /** How long an offer stays valid. Defaults to seven days. */
  offerTtlMs?: number;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

const DEFAULT_OFFER_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * The root side of staged release rollout (roadmap §9.1 step 7). Per channel it publishes signed
 * releases, offers one release to a growing set of instances, watches their heartbeats, halts on
 * failing health, and then offers the instances already upgraded a rollback to the previous
 * release. It only ever produces signed offers: what an instance installs is the district's call.
 */
export class RolloutController {
  readonly #registry: InstanceRegistry;
  readonly #signer: RootReleaseSigner;
  readonly #store: RolloutStore;
  readonly #haltPolicy: HaltPolicy;
  readonly #offerTtlMs: number;
  readonly #now: () => Date;

  constructor(options: RolloutControllerOptions) {
    this.#registry = options.registry;
    this.#signer = options.signer;
    this.#store = options.store;
    this.#haltPolicy = HaltPolicy.parse(options.haltPolicy);
    this.#offerTtlMs = options.offerTtlMs ?? DEFAULT_OFFER_TTL_MS;
    this.#now = options.now ?? (() => new Date());
  }

  /** Publishes a signed release manifest on the channel its statement names. */
  async publish(signedManifest: SignedEnvelope): Promise<ReleaseManifestStatement> {
    const statement = ReleaseManifestStatement.parse(signedManifest.payload);
    const state = await this.#store.channel(statement.channel);
    state.releases[statement.releaseId] = signedManifest;
    await this.#store.saveChannel(statement.channel, state);
    return statement;
  }

  /**
   * Starts rolling a published release out on a channel. The release the channel's previous
   * rollout delivered becomes the rollback target, unless that rollout halted, in which case its
   * own rollback target carries over.
   */
  async startRollout(channel: ReleaseChannel, releaseId: string, target: RolloutTarget): Promise<Rollout> {
    const state = await this.#store.channel(channel);
    const signed = state.releases[releaseId];
    if (signed === undefined) throw new SchoolOsError("not-found", `release ${releaseId} is not published on ${channel}`);
    const previous = state.rollout;
    const previousReleaseId = previous?.status === "active" ? previous.releaseId : previous?.previousReleaseId;
    state.rollout = Rollout.parse({
      channel,
      releaseId,
      version: ReleaseManifestStatement.parse(signed.payload).version,
      target: RolloutTarget.parse(target),
      status: "active",
      startedAt: this.#now().toISOString(),
      ...(previousReleaseId === undefined ? {} : { previousReleaseId }),
    });
    await this.#store.saveChannel(channel, state);
    return state.rollout;
  }

  /** Changes an active rollout's target, e.g. from a canary list to a percentage, then to 100%. */
  async widen(channel: ReleaseChannel, target: RolloutTarget): Promise<Rollout> {
    const state = await this.#store.channel(channel);
    if (state.rollout?.status !== "active") throw new SchoolOsError("conflict", `no active rollout on ${channel}`);
    state.rollout.target = RolloutTarget.parse(target);
    await this.#store.saveChannel(channel, state);
    return state.rollout;
  }

  /** The channel's current rollout, if any. */
  async rollout(channel: ReleaseChannel): Promise<Rollout | undefined> {
    return (await this.#store.channel(channel)).rollout;
  }

  /** Accepts a heartbeat into the registry, then re-evaluates rollout health. */
  async acceptHeartbeat(input: unknown): Promise<void> {
    await this.#registry.acceptHeartbeat(input);
    await this.evaluateHealth();
  }

  /**
   * Halts every active rollout whose upgraded instances fail health past the halt policy. Only
   * heartbeats sent since the rollout started count, and only from instances reporting its
   * version. Returns the rollouts it halted.
   */
  async evaluateHealth(): Promise<Rollout[]> {
    const fleet = await this.#registry.fleetView();
    const halted: Rollout[] = [];
    for (const channel of ReleaseChannel.options) {
      const state = await this.#store.channel(channel);
      const rollout = state.rollout;
      if (rollout?.status !== "active") continue;
      const startedAt = Date.parse(rollout.startedAt);
      const cohort = fleet.filter((entry) =>
        entry.releaseVersion === rollout.version &&
        entry.lastHeartbeatAt !== undefined &&
        Date.parse(entry.lastHeartbeatAt) >= startedAt);
      const failing = cohort.filter((entry) => entry.probes.some((probe) => probe.status === "failing"));
      if (cohort.length === 0 || failing.length <= this.#haltPolicy.maxFailingFraction * cohort.length) continue;
      Object.assign(rollout, { status: "halted", haltedAt: this.#now().toISOString(), haltReason: "health.failing" });
      await this.#store.saveChannel(channel, state);
      halted.push(rollout);
    }
    return halted;
  }

  /**
   * The signed offer, if any, for an instance subscribed to `channel`: the rollout's release while
   * it is active and the instance is in its target, or, once it has halted, a rollback to the
   * previous release for an instance already running the halted one. Refused for an instance
   * that has revoked the root's management access.
   */
  async offerFor(instanceId: InstanceId, channel: ReleaseChannel): Promise<SignedEnvelope | undefined> {
    const state = await this.#store.channel(channel);
    const rollout = state.rollout;
    if (rollout === undefined) return undefined;
    const entry = (await this.#registry.fleetView()).find((e) => e.instanceId === instanceId);
    if (entry === undefined) throw new SchoolOsError("not-found", "instance not registered");

    if (rollout.status === "active") {
      if (entry.releaseVersion === rollout.version || !(await this.#selected(rollout, instanceId))) return undefined;
      return await this.#offer(instanceId, state.releases[rollout.releaseId]!, "upgrade");
    }
    const previous = rollout.previousReleaseId === undefined ? undefined : state.releases[rollout.previousReleaseId];
    if (entry.releaseVersion !== rollout.version || previous === undefined) return undefined;
    return await this.#offer(instanceId, previous, "rollback");
  }

  async #selected(rollout: Rollout, instanceId: InstanceId): Promise<boolean> {
    if (rollout.target.kind === "instances") return rollout.target.instanceIds.includes(instanceId);
    return (await bucket(rollout.releaseId, instanceId)) < rollout.target.percent * 100;
  }

  async #offer(instanceId: InstanceId, signedManifest: SignedEnvelope, purpose: ReleaseOfferPurpose): Promise<SignedEnvelope> {
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#offerTtlMs);
    let statement = ReleaseManifestStatement.parse(signedManifest.payload);
    let manifest = signedManifest;
    // A statement that would lapse before the offer does (typically the previous release's, when
    // rolling back) is re-signed with the same content and a fresh validity.
    if (Date.parse(statement.expiresAt) < expiresAt.getTime()) {
      statement = { ...statement, issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
      manifest = await this.#signer.signManifest(statement);
    }
    const offer = await this.#registry.createReleaseOffer({
      instanceId,
      releaseId: statement.releaseId,
      releaseVersion: statement.version,
      channel: statement.channel,
      purpose,
      offerSequence: await this.#store.nextOfferSequence(instanceId),
      manifestSha256: statement.manifestSha256,
      signedManifest: manifest,
      expiresAt: expiresAt.toISOString(),
    });
    return await this.#signer.signOffer(offer);
  }
}

// A stable bucket in [0, 10000) for an instance in a release's rollout.
async function bucket(releaseId: string, instanceId: InstanceId): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${releaseId}\0${instanceId}`));
  return new DataView(digest).getUint32(0) % 10_000;
}
