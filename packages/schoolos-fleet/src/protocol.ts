import { CapabilityId, InstanceId, OpaqueCode, SemVer, UsdNano, usdNanoFromCents, UtcTimestamp } from "@schoolos/contracts";
import { z } from "zod";
import { Base64Url } from "./encoding.ts";
import { SignedEnvelope } from "./envelope.ts";
import { Ed25519PublicKey, KeyId } from "./identity.ts";
import { CommercialAccountId, SupportSessionId } from "./ids.ts";

// Every message here is a strict allow-list (ADR-0001): a field the schema doesn't name fails to
// parse, so personal data can't ride along in an extra property. `__tests__/no-pii.test.ts` also
// rejects any field whose name suggests personal data.

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

const HeartbeatFields = z.strictObject({
  instanceId: InstanceId,
  sequence: Sequence,
  sentAt: UtcTimestamp,
  releaseVersion: SemVer,
  probes: z.array(HealthProbe).max(64),
  /**
   * The district's total AI spend for the current billing period, in nanodollars (ADR-0008).
   * Present only when the district has opted in; it is one number for the whole instance, never
   * per principal or class.
   */
  aggregateAiSpendUsdNano: UsdNano.optional(),
  /**
   * The same total in whole cents, as agents before SCHO-119 sent it. Accepted on read and
   * converted to {@link Heartbeat}'s `aggregateAiSpendUsdNano`; never sent. A message may carry
   * one form or the other, not both.
   */
  aggregateAiSpendCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

/**
 * A district's periodic report of its version and health. Parsing accepts both the current wire
 * form and the earlier one whose AI spend was in cents, and always yields nanodollars, so the root
 * reads heartbeats from instances on either side of the upgrade. The signature covers the payload
 * as sent, so converting after verification leaves it intact.
 */
export const Heartbeat = HeartbeatFields
  .refine((heartbeat) => heartbeat.aggregateAiSpendCents === undefined || heartbeat.aggregateAiSpendUsdNano === undefined, {
    message: "expected aggregateAiSpendUsdNano or aggregateAiSpendCents, not both",
  })
  .transform(({ aggregateAiSpendCents, ...heartbeat }) =>
    aggregateAiSpendCents === undefined ? heartbeat : { ...heartbeat, aggregateAiSpendUsdNano: usdNanoFromCents(aggregateAiSpendCents) });
/** A heartbeat, with its AI spend in nanodollars. */
export type Heartbeat = z.output<typeof Heartbeat>;
/** A heartbeat as it may arrive on the wire, in either the current or the earlier form. */
export type HeartbeatWire = z.input<typeof Heartbeat>;

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

/**
 * A release channel a district subscribes to: `canary` gets releases first and always needs the
 * district's approval, `stable` gets them once canary instances stayed healthy, and `lts` gets
 * only long-term-support releases.
 */
export const ReleaseChannel = z.enum(["canary", "stable", "lts"]);
/** A release channel name. */
export type ReleaseChannel = z.infer<typeof ReleaseChannel>;

/**
 * Why the root offers a release: to move forward, or to return an instance to the previous signed
 * release after a halted rollout. A district accepts a lower version only as a `rollback`, and
 * only with its explicit approval.
 */
export const ReleaseOfferPurpose = z.enum(["upgrade", "rollback"]);
/** A release offer purpose. */
export type ReleaseOfferPurpose = z.infer<typeof ReleaseOfferPurpose>;

/**
 * The root offering a release to one instance (roadmap R03). The root signs the offer with a
 * release-signing key, and it carries the root's signed release manifest (`signedManifest`, a
 * `SignedReleaseManifest` from `@schoolos/releases`), which the fields here must match. The
 * district verifies both against the release keys it pins and decides; an offer never installs
 * anything by itself.
 */
export const ReleaseOffer = z
  .strictObject({
    instanceId: InstanceId,
    releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "expected a release ID"),
    releaseVersion: SemVer,
    channel: ReleaseChannel,
    purpose: ReleaseOfferPurpose,
    /**
     * Per instance, increasing with every offer the root makes. The district refuses a sequence
     * at or below the highest it has seen, so an old offer can't be replayed.
     */
    offerSequence: Sequence,
    /** The SHA-256 of the release manifest, hex-encoded, so the district can pin exactly what it reviewed. */
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a hex SHA-256"),
    /** The root's signed statement about the release; its payload is checked by `@schoolos/releases`. */
    signedManifest: SignedEnvelope,
    offeredAt: UtcTimestamp,
    /** After this the district refuses the offer. */
    expiresAt: UtcTimestamp,
  })
  .refine((offer) => Date.parse(offer.offeredAt) < Date.parse(offer.expiresAt), {
    message: "expected offeredAt < expiresAt",
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
