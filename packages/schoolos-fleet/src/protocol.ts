import { CapabilityId, SemVer } from "@schoolos/contracts";
import { z } from "zod";
import { Base64Url } from "./encoding.ts";
import { Ed25519PublicKey, KeyId } from "./identity.ts";
import { CommercialAccountId, InstanceId, OpaqueCode, SupportSessionId } from "./ids.ts";

// Every message here is a strict allow-list (ADR-0001): a field the schema doesn't name fails to
// parse, so personal data can't ride along in an extra property. `__tests__/no-pii.test.ts` also
// rejects any field whose name suggests personal data.

/** A UTC timestamp (`2026-10-20T14:00:00Z`). */
export const UtcTimestamp = z.iso.datetime();
/** A UTC timestamp string. */
export type UtcTimestamp = z.infer<typeof UtcTimestamp>;

/**
 * A per-instance message counter. Every signed message after registration carries the next
 * sequence number, and the root accepts only numbers above the last one it accepted.
 */
export const Sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * A secret the root issues once at registration. Only its hash is stored. Presenting it alongside
 * a signature proves an action comes from the district that registered the instance.
 */
export const OwnershipToken = Base64Url.length(43).brand<"ownershipToken">();
/** An ownership token. */
export type OwnershipToken = z.infer<typeof OwnershipToken>;

/** The district role responsible for the instance. The person behind it stays in the commercial system. */
export const ContactRole = z.enum(["district-technology-admin", "district-administrator", "district-billing"]);
/** A contact role. */
export type ContactRole = z.infer<typeof ContactRole>;

/**
 * A district's request to register an instance, signed by the key it registers. Signing with that
 * key proves the district holds it.
 */
export const RegistrationRequest = z.strictObject({
  instanceId: InstanceId,
  /** The district's display label, e.g. "Northfield Public Schools". An organization, not a person. */
  districtLabel: z.string().min(1).max(120),
  publicKey: Ed25519PublicKey,
  releaseVersion: SemVer,
  capabilityIds: z.array(CapabilityId).max(64),
  contactRole: ContactRole,
  commercialAccountId: CommercialAccountId,
  requestedAt: UtcTimestamp,
});
/** A registration request. */
export type RegistrationRequest = z.infer<typeof RegistrationRequest>;

/** The root's reply to a successful registration. The ownership token appears here and nowhere else. */
export const RegistrationReceipt = z.strictObject({
  instanceId: InstanceId,
  keyId: KeyId,
  ownershipToken: OwnershipToken,
  registeredAt: UtcTimestamp,
});
/** A registration receipt. */
export type RegistrationReceipt = z.infer<typeof RegistrationReceipt>;

/** A probe's result. */
export const ProbeStatus = z.enum(["ok", "degraded", "failing"]);
/** A probe status. */
export type ProbeStatus = z.infer<typeof ProbeStatus>;

/**
 * One health probe's result: a status plus an optional opaque code, never a free-text message or
 * a sample of the data the probe looked at.
 */
export const HealthProbe = z.strictObject({
  probeId: OpaqueCode,
  status: ProbeStatus,
  code: OpaqueCode.optional(),
});
/** A health probe result. */
export type HealthProbe = z.infer<typeof HealthProbe>;

/** A district's periodic report of its version and health. */
export const Heartbeat = z.strictObject({
  instanceId: InstanceId,
  sequence: Sequence,
  sentAt: UtcTimestamp,
  releaseVersion: SemVer,
  probes: z.array(HealthProbe).max(64),
  /**
   * The district's total AI spend for the current billing period, in cents. Present only when the
   * district has opted in; it is one number for the whole instance, never per principal or class.
   */
  aggregateAiSpendCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
/** A heartbeat. */
export type Heartbeat = z.infer<typeof Heartbeat>;

/**
 * The district revoking the root's management access. Signed by the instance key and carrying the
 * ownership token, so neither a stolen key nor a leaked token alone can forge it.
 */
export const ManagementRevocation = z.strictObject({
  instanceId: InstanceId,
  sequence: Sequence,
  sentAt: UtcTimestamp,
  ownershipToken: OwnershipToken,
});
/** A management revocation. */
export type ManagementRevocation = z.infer<typeof ManagementRevocation>;

/** A release channel. */
export const ReleaseChannel = z.enum(["stable", "canary"]);
/** A release channel name. */
export type ReleaseChannel = z.infer<typeof ReleaseChannel>;

/**
 * The root offering a release to one instance. A shell for R03, which adds signing, pinning and
 * the district's decision to accept or decline.
 */
export const ReleaseOffer = z.strictObject({
  instanceId: InstanceId,
  releaseVersion: SemVer,
  channel: ReleaseChannel,
  /** The SHA-256 of the release manifest, hex-encoded, so the district can pin exactly what it reviewed. */
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a hex SHA-256"),
  offeredAt: UtcTimestamp,
});
/** A release offer. */
export type ReleaseOffer = z.infer<typeof ReleaseOffer>;

/**
 * The root asking for a support session on one instance. A shell for R03: the district approves
 * each request individually, and the reason is a code rather than text.
 */
export const SupportSessionRequest = z.strictObject({
  requestId: SupportSessionId,
  instanceId: InstanceId,
  reasonCode: OpaqueCode,
  requestedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});
/** A support session request. */
export type SupportSessionRequest = z.infer<typeof SupportSessionRequest>;

/** One instance as the root's fleet view shows it: version and health, nothing else. */
export const FleetViewEntry = z.strictObject({
  instanceId: InstanceId,
  releaseVersion: SemVer,
  /** When the last accepted heartbeat was sent. Absent until the first one arrives. */
  lastHeartbeatAt: UtcTimestamp.optional(),
  probes: z.array(HealthProbe),
});
/** A fleet view entry. */
export type FleetViewEntry = z.infer<typeof FleetViewEntry>;
