import { type CapabilityId, type CommercialAccountId, type InstanceId, SchoolOsError, type UsdNano } from "@schoolos/contracts";
import type { z } from "zod";
import { fromBase64Url, toBase64Url } from "./encoding.ts";
import { type FleetMessageKind, parseWire, SignedEnvelope, verifyEnvelope } from "./envelope.ts";
import { type Ed25519PublicKey, type KeyId, keyIdFor } from "./identity.ts";
import {
  type ContactRole,
  type FleetViewEntry,
  type HealthProbe,
  Heartbeat,
  ManagementRevocation,
  OwnershipToken,
  RegistrationReceipt,
  RegistrationRequest,
  ReleaseOffer,
  SupportSessionRequest,
} from "./protocol.ts";

/** What the root stores about one instance. Everything in it came from an allow-listed message. */
export interface InstanceRecord {
  instanceId: InstanceId;
  keyId: KeyId;
  publicKey: Ed25519PublicKey;
  /** The hex SHA-256 of the ownership token. The token itself is never stored. */
  ownershipTokenSha256: string;
  districtLabel: string;
  commercialAccountId: CommercialAccountId;
  contactRole: ContactRole;
  capabilityIds: CapabilityId[];
  registeredAt: string;
  releaseVersion: string;
  /** The highest sequence accepted so far; 0 until the first signed message after registration. */
  lastSequence: number;
  lastHeartbeatAt?: string;
  probes: HealthProbe[];
  /** The district's last reported AI spend this billing period, in nanodollars, if it shares it. */
  aggregateAiSpendUsdNano?: UsdNano;
  /** When the district revoked the root's management access. The root then issues no offers. */
  managementRevokedAt?: string;
}

/**
 * Where the registry keeps instance records. The private root service implements it over its own
 * database; both writes must be atomic, because they are what make registration first-come and
 * sequence numbers single-use under concurrent requests.
 */
export interface InstanceRegistryStorage {
  /** The record for an instance, if registered. */
  get(instanceId: InstanceId): Promise<InstanceRecord | undefined>;
  /** Inserts a record unless its instance ID or its key ID is already registered. Returns whether it did. */
  insert(record: InstanceRecord): Promise<boolean>;
  /** Replaces a record only if the stored `lastSequence` still equals `expectedLastSequence`. Returns whether it did. */
  update(record: InstanceRecord, expectedLastSequence: number): Promise<boolean>;
  /** Every record. */
  list(): Promise<InstanceRecord[]>;
}

/** An {@link InstanceRegistryStorage} in memory. For tests and as the reference for real implementations. */
export class InMemoryInstanceRegistryStorage implements InstanceRegistryStorage {
  readonly #records = new Map<InstanceId, InstanceRecord>();
  readonly #keys = new Set<KeyId>();

  async get(instanceId: InstanceId): Promise<InstanceRecord | undefined> {
    const record = this.#records.get(instanceId);
    return record && structuredClone(record);
  }

  async insert(record: InstanceRecord): Promise<boolean> {
    if (this.#records.has(record.instanceId) || this.#keys.has(record.keyId)) return false;
    this.#records.set(record.instanceId, structuredClone(record));
    this.#keys.add(record.keyId);
    return true;
  }

  async update(record: InstanceRecord, expectedLastSequence: number): Promise<boolean> {
    const stored = this.#records.get(record.instanceId);
    if (stored?.lastSequence !== expectedLastSequence || stored.keyId !== record.keyId) return false;
    this.#records.set(record.instanceId, structuredClone(record));
    return true;
  }

  async list(): Promise<InstanceRecord[]> {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}

/** What an {@link InstanceRegistry} needs. */
export interface InstanceRegistryOptions {
  storage: InstanceRegistryStorage;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
  /** How far a message's timestamp may be from the root's clock. Defaults to five minutes. */
  maxClockSkewMs?: number;
}

const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60_000;

// One message for every authentication failure, so a caller can't tell an unknown instance from a
// wrong key or a bad signature.
const NOT_ACCEPTED = "signature not accepted";

/**
 * The root's instance registry (roadmap R01): first-come registration, signed heartbeats with
 * replay protection, district-initiated revocation of management access, and a fleet view of
 * version and health. It is the reference implementation the private root service reuses with its
 * own {@link InstanceRegistryStorage}.
 *
 * Every method that takes a district message takes it as `unknown` and parses it here, because it
 * arrives from the network.
 */
export class InstanceRegistry {
  readonly #storage: InstanceRegistryStorage;
  readonly #now: () => Date;
  readonly #maxClockSkewMs: number;

  constructor(options: InstanceRegistryOptions) {
    this.#storage = options.storage;
    this.#now = options.now ?? (() => new Date());
    this.#maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  }

  /**
   * Registers an instance and its public key. The request must be signed by the key it registers.
   * The first registration of an instance ID wins; a later one, including a replay of the first,
   * fails with `conflict`, as does registering a key another instance already holds. The receipt
   * carries the ownership token, which the root returns only this once.
   */
  async register(input: unknown): Promise<RegistrationReceipt> {
    const envelope = parseWire(SignedEnvelope, input, "envelope");
    const request = parseWire(RegistrationRequest, envelope.payload, "registration");
    if (!(await verifyEnvelope(envelope, "registration", request.publicKey))) {
      throw new SchoolOsError("unauthenticated", NOT_ACCEPTED);
    }
    this.#assertFresh(request.requestedAt);

    const ownershipToken = OwnershipToken.parse(toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
    const registeredAt = this.#now().toISOString();
    const keyId = await keyIdFor(request.publicKey);
    const inserted = await this.#storage.insert({
      instanceId: request.instanceId,
      keyId,
      publicKey: request.publicKey,
      ownershipTokenSha256: await sha256Hex(ownershipToken),
      districtLabel: request.districtLabel,
      commercialAccountId: request.commercialAccountId,
      contactRole: request.contactRole,
      capabilityIds: request.capabilityIds,
      registeredAt,
      releaseVersion: request.releaseVersion,
      lastSequence: 0,
      probes: [],
    });
    if (!inserted) throw new SchoolOsError("conflict", "instance or key already registered");
    return RegistrationReceipt.parse({ instanceId: request.instanceId, keyId, ownershipToken, registeredAt });
  }

  /**
   * Accepts a heartbeat: verifies it against the instance's registered key, refuses replays and
   * stale sequence numbers, and records the reported version and health.
   */
  async acceptHeartbeat(input: unknown): Promise<void> {
    const { record, message } = await this.#authenticate(input, "heartbeat", Heartbeat);
    await this.#commit(record, {
      ...record,
      lastSequence: message.sequence,
      releaseVersion: message.releaseVersion,
      lastHeartbeatAt: message.sentAt,
      probes: message.probes,
      aggregateAiSpendUsdNano: message.aggregateAiSpendUsdNano,
    });
  }

  /**
   * Records the district revoking the root's management access. The message must be signed by the
   * instance key and carry the ownership token from registration. After this the root refuses to
   * issue release offers or support session requests for the instance. Heartbeats, which the
   * district chooses to send, are still accepted.
   */
  async revoke(input: unknown): Promise<void> {
    const { record, message } = await this.#authenticate(input, "management-revocation", ManagementRevocation);
    if (!constantTimeEqual(await sha256Hex(message.ownershipToken), record.ownershipTokenSha256)) {
      throw new SchoolOsError("unauthenticated", NOT_ACCEPTED);
    }
    await this.#commit(record, {
      ...record,
      lastSequence: message.sequence,
      managementRevokedAt: record.managementRevokedAt ?? this.#now().toISOString(),
    });
  }

  /**
   * Builds a release offer for an instance whose management access is intact. The caller (the
   * root's rollout controller in `@schoolos/releases`) signs it with a release-signing key.
   */
  async createReleaseOffer(offer: Omit<ReleaseOffer, "offeredAt">): Promise<ReleaseOffer> {
    await this.#assertManageable(offer.instanceId);
    return ReleaseOffer.parse({ ...offer, offeredAt: this.#now().toISOString() });
  }

  /** Builds a support session request for an instance whose management access is intact (approval comes with R03). */
  async createSupportSessionRequest(
    request: Omit<SupportSessionRequest, "requestedAt">,
  ): Promise<SupportSessionRequest> {
    await this.#assertManageable(request.instanceId);
    return SupportSessionRequest.parse({ ...request, requestedAt: this.#now().toISOString() });
  }

  /** Every registered instance's version and health, and nothing else. */
  async fleetView(): Promise<FleetViewEntry[]> {
    const records = await this.#storage.list();
    return records.map((record) => ({
      instanceId: record.instanceId,
      releaseVersion: record.releaseVersion,
      ...(record.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: record.lastHeartbeatAt }),
      probes: record.probes,
    }));
  }

  async #authenticate<T extends z.ZodType<{ instanceId: InstanceId; sequence: number; sentAt: string }>>(
    input: unknown,
    kind: FleetMessageKind,
    schema: T,
  ): Promise<{ record: InstanceRecord; message: z.infer<T> }> {
    const envelope = parseWire(SignedEnvelope, input, "envelope");
    const message = parseWire(schema, envelope.payload, kind);
    // The key comes from the instance's record, never from the message, so a key registered to one
    // instance can't sign for another.
    const record = await this.#storage.get(message.instanceId);
    if (record === undefined || envelope.keyId !== record.keyId) {
      throw new SchoolOsError("unauthenticated", NOT_ACCEPTED);
    }
    if (!(await verifyEnvelope(envelope, kind, record.publicKey))) {
      throw new SchoolOsError("unauthenticated", NOT_ACCEPTED);
    }
    this.#assertFresh(message.sentAt);
    if (message.sequence <= record.lastSequence) {
      throw new SchoolOsError("conflict", "replayed or out-of-order message");
    }
    return { record, message };
  }

  async #commit(previous: InstanceRecord, next: InstanceRecord): Promise<void> {
    // A concurrent message with the same or a lower sequence lost the race; it is a replay.
    if (!(await this.#storage.update(next, previous.lastSequence))) {
      throw new SchoolOsError("conflict", "replayed or out-of-order message");
    }
  }

  #assertFresh(timestamp: string): void {
    if (Math.abs(this.#now().getTime() - Date.parse(timestamp)) > this.#maxClockSkewMs) {
      throw new SchoolOsError("unauthenticated", "message timestamp outside the accepted window");
    }
  }

  async #assertManageable(instanceId: InstanceId): Promise<void> {
    const record = await this.#storage.get(instanceId);
    if (record === undefined) throw new SchoolOsError("not-found", "instance not registered");
    if (record.managementRevokedAt !== undefined) {
      throw new SchoolOsError("forbidden", "the district has revoked management access");
    }
  }
}

async function sha256Hex(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64Url(token)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
