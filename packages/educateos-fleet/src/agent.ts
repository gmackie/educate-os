import { type CapabilityId, type CommercialAccountId, type InstanceId, EducateOsError, type UsdNano } from "@educateos/contracts";
import { signEnvelope, type SignedEnvelope } from "./envelope.ts";
import type { SigningIdentity } from "./identity.ts";
import {
  type ContactRole,
  type HealthProbe,
  Heartbeat,
  ManagementRevocation,
  type OwnershipToken,
  RegistrationRequest,
  RekeyReceipt,
  RekeyRequest,
  ReleaseDecisionReport,
  type ReleaseDecisionKind,
} from "./protocol.ts";

/**
 * Hands out the instance's message sequence numbers. It must be durable: an agent that restarts at
 * 1 is refused by the root as a replay until it catches up. Production uses
 * `DurableObjectSequenceCounter` (`@educateos/fleet/durable-object-store`).
 */
export interface SequenceCounter {
  /** Returns a number greater than any it returned before. */
  next(): Promise<number>;
  /**
   * Makes every later {@link SequenceCounter.next} return more than `floor`. A rekey receipt
   * carries the root's last accepted sequence, so an agent whose counter was lost resumes above it.
   */
  ensureAbove(floor: number): Promise<void>;
}

/** A {@link SequenceCounter} that lives in memory. For tests and the local harness only. */
export class InMemorySequenceCounter implements SequenceCounter {
  #last = 0;

  async next(): Promise<number> {
    this.#last += 1;
    return this.#last;
  }

  async ensureAbove(floor: number): Promise<void> {
    this.#last = Math.max(this.#last, floor);
  }
}

/** What a {@link DistrictAgent} needs. */
export interface DistrictAgentOptions {
  /** The instance's own key pair. After a rekey, {@link DistrictAgent.adoptRekey} replaces it. */
  identity: SigningIdentity;
  instanceId: InstanceId;
  sequence: SequenceCounter;
  /** Whether the district opted in to sharing its aggregate AI spend with the root. */
  sharesAggregateSpend: boolean;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** The facts a registration states about the instance. */
export interface RegistrationDetails {
  districtLabel: string;
  releaseVersion: string;
  capabilityIds: readonly CapabilityId[];
  contactRole: ContactRole;
  commercialAccountId: CommercialAccountId;
}

/** The facts a heartbeat reports. */
export interface HeartbeatDetails {
  releaseVersion: string;
  probes: readonly HealthProbe[];
  /**
   * The district's AI spend this billing period, in nanodollars. Sent only if the district opted
   * in; supplying it otherwise is an error.
   */
  aggregateAiSpendUsdNano?: UsdNano;
}

/** The facts a release decision report states. Reason codes only, never free text. */
export interface ReleaseDecisionDetails {
  offerSequence: number;
  releaseId: string;
  decision: ReleaseDecisionKind;
  reasonCode?: string;
  deferredUntil?: string;
}

/**
 * The district side of the fleet protocol: builds and signs the messages the instance sends to the
 * root. Each message is assembled field by field from the allow-list and parsed before signing,
 * so nothing outside the protocol schema can be signed and sent. Transport is the caller's.
 */
export class DistrictAgent {
  #identity: SigningIdentity;
  readonly #instanceId: InstanceId;
  readonly #sequence: SequenceCounter;
  readonly #sharesAggregateSpend: boolean;
  readonly #now: () => Date;

  constructor(options: DistrictAgentOptions) {
    this.#identity = options.identity;
    this.#instanceId = options.instanceId;
    this.#sequence = options.sequence;
    this.#sharesAggregateSpend = options.sharesAggregateSpend;
    this.#now = options.now ?? (() => new Date());
  }

  /** The instance this agent speaks for. */
  get instanceId(): InstanceId {
    return this.#instanceId;
  }

  /** A signed registration of this instance and its public key. */
  async register(details: RegistrationDetails): Promise<SignedEnvelope> {
    const request = RegistrationRequest.parse({
      instanceId: this.#instanceId,
      districtLabel: details.districtLabel,
      publicKey: this.#identity.publicKey,
      releaseVersion: details.releaseVersion,
      capabilityIds: details.capabilityIds,
      contactRole: details.contactRole,
      commercialAccountId: details.commercialAccountId,
      requestedAt: this.#timestamp(),
    });
    return await signEnvelope(this.#identity, "registration", request);
  }

  /** A signed heartbeat with the next sequence number. */
  async heartbeat(details: HeartbeatDetails): Promise<SignedEnvelope> {
    if (details.aggregateAiSpendUsdNano !== undefined && !this.#sharesAggregateSpend) {
      throw new EducateOsError("policy-violation", "the district has not opted in to sharing aggregate AI spend");
    }
    const heartbeat = Heartbeat.parse({
      instanceId: this.#instanceId,
      sequence: await this.#sequence.next(),
      sentAt: this.#timestamp(),
      releaseVersion: details.releaseVersion,
      probes: details.probes.map((probe) => ({ probeId: probe.probeId, status: probe.status, code: probe.code })),
      aggregateAiSpendUsdNano: details.aggregateAiSpendUsdNano,
    });
    return await signEnvelope(this.#identity, "heartbeat", heartbeat);
  }

  /**
   * A request to replace the instance key with `next`, signed by `next` and authorized by the
   * current ownership token. Works without the old key, so it is also how a district recovers an
   * instance whose key was lost. The agent keeps signing with its current key until
   * {@link DistrictAgent.adoptRekey} accepts the root's receipt.
   */
  async requestRekey(next: SigningIdentity, ownershipToken: OwnershipToken): Promise<SignedEnvelope> {
    const request = RekeyRequest.parse({
      instanceId: this.#instanceId,
      publicKey: next.publicKey,
      ownershipToken,
      requestedAt: this.#timestamp(),
    });
    return await signEnvelope(next, "rekey", request);
  }

  /**
   * Switches to `next` once the root confirmed the rekey, and moves the sequence counter above the
   * root's last accepted sequence. The receipt's new ownership token is the caller's to store; the
   * old one no longer works.
   */
  async adoptRekey(next: SigningIdentity, input: RekeyReceipt): Promise<void> {
    const receipt = RekeyReceipt.parse(input);
    if (receipt.instanceId !== this.#instanceId || receipt.keyId !== next.keyId) {
      throw new EducateOsError("validation-failed", "the rekey receipt is for another instance or key");
    }
    await this.#sequence.ensureAbove(receipt.lastSequence);
    this.#identity = next;
  }

  /** A signed report of what the district decided about a release offer. */
  async reportReleaseDecision(details: ReleaseDecisionDetails): Promise<SignedEnvelope> {
    const report = ReleaseDecisionReport.parse({
      instanceId: this.#instanceId,
      sequence: await this.#sequence.next(),
      sentAt: this.#timestamp(),
      offerSequence: details.offerSequence,
      releaseId: details.releaseId,
      decision: details.decision,
      reasonCode: details.reasonCode,
      deferredUntil: details.deferredUntil,
    });
    return await signEnvelope(this.#identity, "release-decision", report);
  }

  /** A signed revocation of the root's management access to this instance. */
  async revokeManagement(ownershipToken: OwnershipToken): Promise<SignedEnvelope> {
    const revocation = ManagementRevocation.parse({
      instanceId: this.#instanceId,
      sequence: await this.#sequence.next(),
      sentAt: this.#timestamp(),
      ownershipToken,
    });
    return await signEnvelope(this.#identity, "management-revocation", revocation);
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}
