import { z } from "zod";
import { InstanceId, EducateOsError, type ContentDigest } from "@educateos/contracts";
import { sha256Digest } from "@educateos/learning-artifacts";
import { canonicalJsonBytes, ExportId, SubjectRef, type StudentArchiveManifest } from "./archive.ts";

/** A district display label, as it appears in an archive's manifest. */
export const DistrictLabel = z.string().min(1).max(200);

/**
 * A district at either end of a transfer: its display label and, when it has one, its fleet
 * instance ID. Nothing else about a district crosses, and no district ID ever does.
 */
export const TransferParty = z.strictObject({
  label: DistrictLabel,
  instanceId: InstanceId.optional(),
});
/** A transfer party. */
export type TransferParty = z.infer<typeof TransferParty>;

/** The classes of archive item a learner can consent to transferring. */
export const TransferItemClass = z.enum(["artifacts", "submissions", "feedback", "resources"]);
/** A transfer item class. */
export type TransferItemClass = z.infer<typeof TransferItemClass>;

/** Who gave consent: the learner themselves, or their guardian. */
export const Consenter = z.enum(["learner", "guardian"]);
/** A consenter. */
export type Consenter = z.infer<typeof Consenter>;

/** Identifies one consent: 32 lowercase hex digits, random per consent. */
export const TransferConsentId = z.string().regex(/^[0-9a-f]{32}$/, "expected a consent ID").brand<"transfer-consent">();
/** A transfer consent identifier. */
export type TransferConsentId = z.infer<typeof TransferConsentId>;

/**
 * A learner's (or guardian's) consent to move one export's items to one destination district. It
 * names the export by its ID and the learner by the export's pseudonym, so it cannot be reused for
 * another archive. `revokedAt` is the only part that ever changes, and it is not covered by a
 * transfer package's signature (see {@link consentGrantDigest}).
 */
export const TransferConsent = z
  .strictObject({
    id: TransferConsentId,
    exportId: ExportId,
    subject: SubjectRef,
    consentedBy: Consenter,
    itemClasses: z.array(TransferItemClass).min(1).max(TransferItemClass.options.length),
    source: TransferParty,
    destination: TransferParty,
    grantedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().optional(),
  })
  .refine((c) => new Set(c.itemClasses).size === c.itemClasses.length, "each item class is listed once")
  .refine((c) => c.grantedAt < c.expiresAt, "consent expires after it is granted");
/** A transfer consent. */
export type TransferConsent = z.infer<typeof TransferConsent>;

/**
 * A district's rule for who may consent to a transfer: learners at or over `selfConsentAge`
 * consent for themselves, and a guardian consents for anyone younger. It is the district's own
 * input; EducateOS does not pick an age.
 */
export const ConsentAgePolicy = z.strictObject({ selfConsentAge: z.int().min(0).max(30) });
/** A consent age policy. */
export type ConsentAgePolicy = z.infer<typeof ConsentAgePolicy>;

/** Who must consent for a learner of `learnerAge` under `policy`. */
export function requiredConsenter(policy: ConsentAgePolicy, learnerAge: number): Consenter {
  return learnerAge >= ConsentAgePolicy.parse(policy).selfConsentAge ? "learner" : "guardian";
}

/** What issuing a consent takes. The learner's age is used for the age policy and never stored. */
export interface TransferConsentRequest {
  /** The export the consent is for. */
  manifest: StudentArchiveManifest;
  /** The learner's age in whole years when consent is given. */
  learnerAge: number;
  /** Who is consenting. It must be who the age policy requires. */
  consentedBy: Consenter;
  itemClasses: TransferItemClass[];
  source: TransferParty;
  destination: TransferParty;
  /** How long the consent lasts. */
  validForDays: number;
}

/** The longest a transfer consent may last. */
export const MAX_CONSENT_DAYS = 90;

/**
 * Records consent at the source district. It refuses when the consenter is not who `agePolicy`
 * requires, when the source is not the district that made the export, or when the consent would
 * last longer than {@link MAX_CONSENT_DAYS}.
 */
export function issueTransferConsent(agePolicy: ConsentAgePolicy, request: TransferConsentRequest, now: Date, randomHex: () => string = () => crypto.randomUUID().replaceAll("-", "")): TransferConsent {
  const required = requiredConsenter(agePolicy, request.learnerAge);
  if (request.consentedBy !== required) {
    throw new EducateOsError("forbidden", required === "guardian" ? "A guardian must consent to this transfer." : "The learner consents to this transfer themselves.");
  }
  if (request.source.label !== request.manifest.district.displayName) {
    throw new EducateOsError("validation-failed", "Consent is given by the district that made the export.");
  }
  if (!Number.isInteger(request.validForDays) || request.validForDays < 1 || request.validForDays > MAX_CONSENT_DAYS) {
    throw new EducateOsError("validation-failed", `Consent lasts between 1 and ${MAX_CONSENT_DAYS} days.`);
  }
  return TransferConsent.parse({
    id: randomHex(),
    exportId: request.manifest.exportId,
    subject: request.manifest.subject,
    consentedBy: request.consentedBy,
    itemClasses: request.itemClasses,
    source: request.source,
    destination: request.destination,
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + request.validForDays * 86_400_000).toISOString(),
  });
}

/** The consent, revoked at `now`. Revoking twice keeps the first time. */
export function revokeTransferConsent(consent: TransferConsent, now: Date): TransferConsent {
  return TransferConsent.parse({ ...consent, revokedAt: consent.revokedAt ?? now.toISOString() });
}

/** The digest of the consent as granted: everything but `revokedAt`, so a signature survives revocation and still binds the grant. */
export async function consentGrantDigest(consent: TransferConsent): Promise<ContentDigest> {
  const { revokedAt: _revokedAt, ...grant } = consent;
  return sha256Digest(canonicalJsonBytes(grant));
}

/** Whether a party names the same district as `self`: by instance ID when both have one, otherwise by label. */
export function sameParty(party: TransferParty, self: TransferParty): boolean {
  return party.instanceId !== undefined && self.instanceId !== undefined ? party.instanceId === self.instanceId : party.label === self.label;
}
