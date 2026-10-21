import { type CapabilityId, SchoolOsError, type InstanceId, type UsdNano } from "@schoolos/contracts";
import { signEnvelope, type SignedEnvelope } from "./envelope.ts";
import type { SigningIdentity } from "./identity.ts";
import type { CommercialAccountId } from "./ids.ts";
import {
  type ContactRole,
  type HealthProbe,
  Heartbeat,
  ManagementRevocation,
  type OwnershipToken,
  RegistrationRequest,
} from "./protocol.ts";

/**
 * Hands out the instance's message sequence numbers. It must be durable (a Durable Object or a
 * D1 row in production): an agent that restarts at 1 is refused by the root as a replay until it
 * catches up.
 */
export interface SequenceCounter {
  /** Returns a number greater than any it returned before. */
  next(): Promise<number>;
}

/** A {@link SequenceCounter} that lives in memory. For tests and the local harness only. */
export class InMemorySequenceCounter implements SequenceCounter {
  #last = 0;

  async next(): Promise<number> {
    this.#last += 1;
    return this.#last;
  }
}

/** What a {@link DistrictAgent} needs. */
export interface DistrictAgentOptions {
  /** The instance's own key pair. */
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

/**
 * The district side of the fleet protocol: builds and signs the messages the instance sends to the
 * root. Each message is assembled field by field from the allow-list and parsed before signing,
 * so nothing outside the protocol schema can be signed and sent. Transport is the caller's.
 */
export class DistrictAgent {
  readonly #identity: SigningIdentity;
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
      throw new SchoolOsError("policy-violation", "the district has not opted in to sharing aggregate AI spend");
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
