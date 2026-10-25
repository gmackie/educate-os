import { OpaqueCode, EducateOsError, SemVer, UtcTimestamp, type InstanceId } from "@educateos/contracts";
import {
  type EntitlementCache,
  parseWire,
  type ReleaseDecisionDetails,
  ReleaseOffer,
  ReleaseOfferPurpose,
  Sequence,
  SerialQueue,
  SignedEnvelope,
  verifyEnvelope,
} from "@educateos/fleet";
import { z } from "zod";
import { MigrationNote, ReleaseId, ReleaseManifestStatement, Sha256Hex, verifySignedReleaseManifest } from "./manifest.ts";
import { type DistrictReleasePolicy, DriftReport, requiredAcknowledgements } from "./policy.ts";
import { compareSemVer } from "./semver.ts";
import { acceptReleaseKeySet, ReleaseTrust, trustedKey } from "./trust.ts";

/** A release the district has installed. The last one in the history is what is running. */
export const InstalledRelease = z.strictObject({
  releaseId: ReleaseId,
  version: SemVer,
  minimumCompatibleVersion: SemVer,
  manifestSha256: Sha256Hex,
  installedAt: UtcTimestamp,
});
/** An installed release. */
export type InstalledRelease = z.infer<typeof InstalledRelease>;

/**
 * Where an offer stands. `pending` and `deferred` wait for the district; `approved` may be applied;
 * `declined` never will be unless the district rescinds its decline; `superseded` was replaced by a
 * newer offer; `installed` was applied.
 */
export const OfferStatus = z.enum(["pending", "deferred", "approved", "declined", "superseded", "installed"]);
/** An offer status. */
export type OfferStatus = z.infer<typeof OfferStatus>;

/** The district's record of one verified offer and what it decided. */
export const OfferRecord = z.strictObject({
  offerSequence: Sequence,
  purpose: ReleaseOfferPurpose,
  statement: ReleaseManifestStatement,
  receivedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  status: OfferStatus,
  /** Who made the last decision: a district administrator, or the district's own auto-apply policy. */
  decidedBy: z.enum(["district", "policy"]).optional(),
  decidedAt: UtcTimestamp.optional(),
  declineReason: OpaqueCode.optional(),
  deferredUntil: UtcTimestamp.optional(),
  acknowledgedMigrations: z.array(MigrationNote.shape.migrationId),
});
/** An offer record. */
export type OfferRecord = z.infer<typeof OfferRecord>;

/** A release the district declined. Every later offer of it is declined on arrival. */
export const DeclinedRelease = z.strictObject({
  releaseId: ReleaseId,
  reason: OpaqueCode,
  declinedAt: UtcTimestamp,
});
/** A declined release. */
export type DeclinedRelease = z.infer<typeof DeclinedRelease>;

/** Everything the district keeps about releases: its trust, its history, its decisions. */
export const DistrictReleaseState = z.strictObject({
  trust: ReleaseTrust,
  /** The highest offer sequence accepted; 0 before the first offer. */
  lastOfferSequence: z.number().int().min(0),
  installed: z.array(InstalledRelease).min(1),
  declined: z.array(DeclinedRelease),
  offers: z.array(OfferRecord),
});
/** The district's release state. */
export type DistrictReleaseState = z.infer<typeof DistrictReleaseState>;

/**
 * Where the district keeps its release state. Production keeps it in a Durable Object
 * (`DurableObjectDistrictReleaseStore`, `@educateos/releases/durable-object-store`) that also hosts
 * the manager; it never leaves the district's account. The manager serializes its own
 * read-modify-write cycles, so a store only has to save atomically.
 */
export interface DistrictReleaseStore {
  /** The stored state, if any. */
  load(): Promise<DistrictReleaseState | undefined>;
  /** Replaces the stored state. */
  save(state: DistrictReleaseState): Promise<void>;
}

/** A {@link DistrictReleaseStore} in memory. For tests and the local harness only. */
export class InMemoryDistrictReleaseStore implements DistrictReleaseStore {
  #state: DistrictReleaseState | undefined;

  async load(): Promise<DistrictReleaseState | undefined> {
    return this.#state && structuredClone(this.#state);
  }

  async save(state: DistrictReleaseState): Promise<void> {
    this.#state = structuredClone(state);
  }
}

/** What a {@link DistrictReleaseManager} needs. */
export interface DistrictReleaseManagerOptions {
  instanceId: InstanceId;
  policy: DistrictReleasePolicy;
  store: DistrictReleaseStore;
  /** The pinned release keys and the running release, used only when the store is empty. */
  initial: { trust: ReleaseTrust; installed: InstalledRelease };
  /**
   * The district's entitlement cache. While it blocks root-managed changes (lapsed or absent), the
   * district may still review offers and roll back, but no upgrade is cleared to apply.
   */
  entitlement: Pick<EntitlementCache, "evaluate">;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** The district's approval of a release. */
export interface ApprovalDecision {
  /** The dry-run drift report for the offered release, which the district reviewed. */
  drift: DriftReport;
  /** Every migration {@link requiredAcknowledgements} names, acknowledged by the administrator. */
  acknowledgedMigrations?: readonly string[];
  /** Must be true to approve a rollback offer: going back a version is never implicit. */
  asRollback?: boolean;
}

/** A release the district has approved, cleared to apply now. */
export interface AuthorizedRelease {
  offerSequence: number;
  purpose: ReleaseOfferPurpose;
  statement: ReleaseManifestStatement;
}

const OPEN: readonly OfferStatus[] = ["pending", "deferred", "approved"];

/**
 * The district side of release management (roadmap R03, threat model T12). It verifies offers
 * from the root against locally pinned release keys and records what the district decides. Its
 * one path to an install is {@link DistrictReleaseManager.authorizeApply}, which succeeds only for
 * an approved offer, so a root, compromised or not, can offer releases but never install one.
 */
export class DistrictReleaseManager {
  readonly #instanceId: InstanceId;
  readonly #policy: DistrictReleasePolicy;
  readonly #store: DistrictReleaseStore;
  readonly #initial: DistrictReleaseManagerOptions["initial"];
  readonly #entitlement: DistrictReleaseManagerOptions["entitlement"];
  readonly #now: () => Date;
  // Every step that reads, changes and saves the state runs here, so two requests to the hosting
  // Durable Object can't interleave and lose one's change (an offer's signatures are awaited).
  readonly #queue = new SerialQueue();

  constructor(options: DistrictReleaseManagerOptions) {
    this.#instanceId = options.instanceId;
    this.#policy = options.policy;
    this.#store = options.store;
    this.#initial = options.initial;
    this.#entitlement = options.entitlement;
    this.#now = options.now ?? (() => new Date());
  }

  /** The district's release state: trust, install history, decisions. */
  async state(): Promise<DistrictReleaseState> {
    const stored = await this.#store.load();
    if (stored !== undefined) return stored;
    return DistrictReleaseState.parse({
      trust: this.#initial.trust,
      lastOfferSequence: 0,
      installed: [this.#initial.installed],
      declined: [],
      offers: [],
    });
  }

  /**
   * Accepts a release key set signed by a threshold of the pinned offline root keys: a rotation,
   * or an emergency revocation of a stolen release key (see {@link acceptReleaseKeySet}).
   */
  async acceptReleaseKeySet(input: unknown): Promise<ReleaseTrust> {
    return this.#queue.run(async () => {
      const state = await this.state();
      state.trust = await acceptReleaseKeySet(state.trust, input, this.#now());
      await this.#save(state);
      return state.trust;
    });
  }

  /**
   * Verifies an offer and records it. The offer and the release manifest it carries must both be
   * signed by trusted keys and agree with each other; the offer must be for this instance and the
   * subscribed channel, unexpired, and newer than every offer seen before. A lower version is
   * accepted only as a rollback to a release this district has run.
   *
   * The offer is recorded `declined` if the district declined that release before, `approved` if
   * the policy auto-applies it, and `pending` otherwise. Older open offers are superseded.
   */
  async receiveOffer(input: unknown): Promise<OfferRecord> {
    return this.#queue.run(async () => {
      const now = this.#now();
      const state = await this.state();
      const envelope = parseWire(SignedEnvelope, input, "envelope");
      const offer = parseWire(ReleaseOffer, envelope.payload, "release offer");
      const key = trustedKey(state.trust, envelope.keyId, now);
      if (key === undefined || !(await verifyEnvelope(envelope, "release-offer", key.publicKey))) {
        throw new EducateOsError("unauthenticated", "release offer signature not accepted");
      }
      if (offer.instanceId !== this.#instanceId) throw new EducateOsError("forbidden", "release offer is for another instance");
      if (now.getTime() >= Date.parse(offer.expiresAt)) throw new EducateOsError("unauthenticated", "release offer has expired");
      if (offer.offerSequence <= state.lastOfferSequence) throw new EducateOsError("conflict", "replayed or out-of-order release offer");

      const statement = await verifySignedReleaseManifest(offer.signedManifest, state.trust, { now });
      if (
        statement.releaseId !== offer.releaseId ||
        statement.version !== offer.releaseVersion ||
        statement.channel !== offer.channel ||
        statement.manifestSha256 !== offer.manifestSha256
      ) {
        throw new EducateOsError("unauthenticated", "release offer does not match its signed manifest");
      }
      if (offer.channel !== this.#policy.channel) {
        throw new EducateOsError("forbidden", `the district subscribes to ${this.#policy.channel}, not ${offer.channel}`);
      }
      assertVersionStep(offer.purpose, statement, state.installed);

      for (const record of state.offers) if (OPEN.includes(record.status)) record.status = "superseded";
      const declined = state.declined.find((d) => d.releaseId === statement.releaseId);
      const record: OfferRecord = {
        offerSequence: offer.offerSequence,
        purpose: offer.purpose,
        statement,
        receivedAt: now.toISOString(),
        expiresAt: offer.expiresAt,
        status: "pending",
        acknowledgedMigrations: [],
      };
      if (declined !== undefined) {
        Object.assign(record, { status: "declined", decidedBy: "district", decidedAt: declined.declinedAt, declineReason: declined.reason });
      } else if (this.#autoApplies(offer.purpose, statement)) {
        Object.assign(record, { status: "approved", decidedBy: "policy", decidedAt: now.toISOString() });
      }
      state.lastOfferSequence = offer.offerSequence;
      state.offers.push(record);
      await this.#save(state);
      return record;
    });
  }

  /**
   * Approves an offer after the district reviewed its drift report. A rollback needs `asRollback`,
   * and every migration in {@link requiredAcknowledgements} must be acknowledged. Approving an
   * offer the policy already approved records the district's acknowledgements on it.
   */
  async approve(offerSequence: number, decision: ApprovalDecision): Promise<OfferRecord> {
    return this.#queue.run(async () => {
      const now = this.#now();
      const state = await this.state();
      const record = openRecord(state, offerSequence);
      if (now.getTime() >= Date.parse(record.expiresAt)) throw new EducateOsError("conflict", "release offer has expired");
      if (record.purpose === "rollback" && decision.asRollback !== true) {
        throw new EducateOsError("policy-violation", "a rollback must be approved explicitly as a rollback");
      }
      const drift = checkedDrift(record, decision.drift);
      const acknowledged = new Set(decision.acknowledgedMigrations ?? []);
      const missing = requiredAcknowledgements(record.statement, drift).filter((id) => !acknowledged.has(id));
      if (missing.length > 0) {
        throw new EducateOsError("policy-violation", `irreversible migrations need acknowledgement: ${missing.join(", ")}`);
      }
      Object.assign(record, {
        status: "approved",
        decidedBy: "district",
        decidedAt: now.toISOString(),
        acknowledgedMigrations: [...acknowledged].toSorted(),
      });
      await this.#save(state);
      return record;
    });
  }

  /**
   * Declines an offer for a reason. The decline covers the release, not just this offer: every
   * later offer of it is declined on arrival, whatever the root does, until the district itself
   * rescinds it.
   */
  async decline(offerSequence: number, reason: string): Promise<OfferRecord> {
    return this.#queue.run(async () => {
      const reasonCode = parseWire(OpaqueCode, reason, "decline reason");
      const now = this.#now().toISOString();
      const state = await this.state();
      const record = openRecord(state, offerSequence);
      Object.assign(record, { status: "declined", decidedBy: "district", decidedAt: now, declineReason: reasonCode });
      if (!state.declined.some((d) => d.releaseId === record.statement.releaseId)) {
        state.declined.push({ releaseId: record.statement.releaseId, reason: reasonCode, declinedAt: now });
      }
      await this.#save(state);
      return record;
    });
  }

  /** Defers an offer until a later time. A deferred offer is not applied, even under an auto-apply policy. */
  async defer(offerSequence: number, until: Date): Promise<OfferRecord> {
    return this.#queue.run(async () => {
      const state = await this.state();
      const record = openRecord(state, offerSequence);
      Object.assign(record, {
        status: "deferred",
        decidedBy: "district",
        decidedAt: this.#now().toISOString(),
        deferredUntil: until.toISOString(),
      });
      await this.#save(state);
      return record;
    });
  }

  /** Withdraws the district's decline of a release; its declined offers become pending again. */
  async rescindDecline(releaseId: string): Promise<void> {
    return this.#queue.run(async () => {
      const state = await this.state();
      state.declined = state.declined.filter((d) => d.releaseId !== releaseId);
      for (const record of state.offers) {
        if (record.status === "declined" && record.statement.releaseId === releaseId) {
          record.status = "pending";
          delete record.declineReason;
        }
      }
      await this.#save(state);
    });
  }

  /**
   * Clears an approved offer to be applied now, against a fresh drift report: the account may have
   * changed since approval, and a pending migration nobody acknowledged stops the apply. This is
   * the only way to an installable release; anything not `approved` is refused. While the
   * entitlement cache blocks root-managed changes, an upgrade is refused (`policy-violation`) but a
   * rollback still goes ahead: going back to a release the district already ran is never a new
   * root-managed change, and it may be what keeps a broken instance usable.
   */
  async authorizeApply(offerSequence: number, drift: DriftReport): Promise<AuthorizedRelease> {
    return this.#queue.run(async () => {
      const state = await this.state();
      const record = state.offers.find((r) => r.offerSequence === offerSequence);
      if (record?.status !== "approved") throw new EducateOsError("forbidden", "the district has not approved this release offer");
      const checked = checkedDrift(record, drift);
      const acknowledged = new Set(record.acknowledgedMigrations);
      const missing = requiredAcknowledgements(record.statement, checked).filter((id) => !acknowledged.has(id));
      if (missing.length > 0) {
        throw new EducateOsError("policy-violation", `irreversible migrations need acknowledgement: ${missing.join(", ")}`);
      }
      if (record.purpose === "upgrade" && (await this.#entitlement.evaluate()).rootManagedChanges === "blocked") {
        throw new EducateOsError("policy-violation", "the entitlement has lapsed: only a rollback can be applied");
      }
      return { offerSequence, purpose: record.purpose, statement: record.statement };
    });
  }

  /** Records that an authorized release was applied; it becomes the running release. */
  async recordInstalled(offerSequence: number): Promise<InstalledRelease> {
    return this.#queue.run(async () => {
      const state = await this.state();
      const record = state.offers.find((r) => r.offerSequence === offerSequence);
      if (record?.status !== "approved") throw new EducateOsError("forbidden", "the district has not approved this release offer");
      record.status = "installed";
      const installed: InstalledRelease = {
        releaseId: record.statement.releaseId,
        version: record.statement.version,
        minimumCompatibleVersion: record.statement.minimumCompatibleVersion,
        manifestSha256: record.statement.manifestSha256,
        installedAt: this.#now().toISOString(),
      };
      state.installed.push(installed);
      await this.#save(state);
      return installed;
    });
  }

  #autoApplies(purpose: ReleaseOfferPurpose, statement: ReleaseManifestStatement): boolean {
    return this.#policy.autoApply &&
      this.#policy.channel !== "canary" &&
      purpose === "upgrade" &&
      statement.migrations.every((note) => !note.irreversible);
  }

  async #save(state: DistrictReleaseState): Promise<void> {
    await this.#store.save(DistrictReleaseState.parse(state));
  }
}

/**
 * What the district reports to the root about an offer it has decided on (the fleet's signed
 * `release-decision` message, sent with `DistrictAgent.reportReleaseDecision`), or undefined for an
 * offer that awaits a decision or was superseded or installed. Reason codes only.
 */
export function releaseDecisionFor(record: OfferRecord): ReleaseDecisionDetails | undefined {
  const base = { offerSequence: record.offerSequence, releaseId: record.statement.releaseId };
  switch (record.status) {
    case "approved":
      return { ...base, decision: "approved" };
    case "declined":
      return { ...base, decision: "declined", reasonCode: record.declineReason };
    case "deferred":
      return { ...base, decision: "deferred", deferredUntil: record.deferredUntil };
    default:
      return undefined;
  }
}

// Forward steps must be upgrades from a version the release supports; backward steps must be
// rollbacks to a release this district actually ran, so a root can't push an old, vulnerable
// release the district never had by calling it a rollback.
function assertVersionStep(
  purpose: ReleaseOfferPurpose,
  statement: ReleaseManifestStatement,
  installed: readonly InstalledRelease[],
): void {
  const running = installed.at(-1)!;
  const step = compareSemVer(statement.version, running.version);
  if (step === 0) throw new EducateOsError("conflict", "the offered version is already running");
  if (step > 0) {
    if (purpose !== "upgrade") throw new EducateOsError("policy-violation", "a newer version can only be offered as an upgrade");
    if (compareSemVer(running.version, statement.minimumCompatibleVersion) < 0) {
      throw new EducateOsError("policy-violation", `the release cannot upgrade from ${running.version}`);
    }
    return;
  }
  if (purpose !== "rollback") throw new EducateOsError("policy-violation", "a downgrade can only be offered as a rollback");
  const ran = installed.some((r) => r.releaseId === statement.releaseId && r.manifestSha256 === statement.manifestSha256);
  if (!ran) throw new EducateOsError("policy-violation", "a rollback must return to a release this district has run");
}

function openRecord(state: DistrictReleaseState, offerSequence: number): OfferRecord {
  const record = state.offers.find((r) => r.offerSequence === offerSequence);
  if (record === undefined) throw new EducateOsError("not-found", "no such release offer");
  if (!OPEN.includes(record.status)) throw new EducateOsError("conflict", `the release offer is ${record.status}`);
  return record;
}

function checkedDrift(record: OfferRecord, input: DriftReport): DriftReport {
  const drift = DriftReport.parse(input);
  if (drift.releaseId !== record.statement.releaseId || drift.manifestSha256 !== record.statement.manifestSha256) {
    throw new EducateOsError("validation-failed", "the drift report is for a different release");
  }
  if (!drift.ready) throw new EducateOsError("conflict", "the dry run is blocked; resolve it before applying");
  return drift;
}
