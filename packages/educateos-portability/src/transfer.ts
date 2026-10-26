import { z } from "zod";
import { ContentDigest, EducateOsError } from "@educateos/contracts";
import { sha256Digest } from "@educateos/learning-artifacts";
import { ExportId, SubjectRef } from "./archive.ts";
import { consentGrantDigest, TransferConsent, TransferConsentId, TransferParty } from "./consent.ts";
import { fromBase64Url, signEnvelope, SignedEnvelope, toBase64Url, type SigningIdentity } from "@educateos/fleet";
import { recordFormat } from "./legacy-formats.ts";
import { validateArchive } from "./validate.ts";

/**
 * What the source district signs for a transfer: which archive (by digest), for which consent (by
 * the digest of its grant), from whom and to whom. The archive itself is not in the signed bytes,
 * so the signature is detached and the archive file is unchanged.
 */
export const TransferStatement = z.strictObject({
  format: recordFormat("transfer-statement"),
  formatVersion: z.literal(1),
  archiveDigest: ContentDigest,
  exportId: ExportId,
  subject: SubjectRef,
  consentId: TransferConsentId,
  consentDigest: ContentDigest,
  source: TransferParty,
  destination: TransferParty,
  issuedAt: z.iso.datetime(),
});
/** A transfer statement. */
export type TransferStatement = z.infer<typeof TransferStatement>;

/** A transfer package: the `.educateos` archive, the consent it moves under, and the source's detached signature, if it signed. */
export interface TransferPackage {
  archive: Uint8Array<ArrayBuffer>;
  consent: TransferConsent;
  signature?: SignedEnvelope;
}

/**
 * Issues a signed transfer package at the source district, signed with its fleet agent identity as
 * a `student-transfer` message (`@educateos/fleet`). The archive is validated first, and the consent
 * must be for it, unrevoked and unexpired.
 */
export async function issueTransferPackage(identity: SigningIdentity, archive: Uint8Array<ArrayBuffer>, rawConsent: TransferConsent, now: Date): Promise<TransferPackage> {
  const consent = TransferConsent.parse(rawConsent);
  const { manifest } = await validateArchive(archive);
  if (consent.exportId !== manifest.exportId || consent.subject !== manifest.subject) {
    throw new EducateOsError("validation-failed", "This consent is for another export.");
  }
  if (consent.revokedAt !== undefined || now.toISOString() >= consent.expiresAt) {
    throw new EducateOsError("forbidden", "This consent is no longer in effect.");
  }
  const statement: TransferStatement = {
    format: "educateos.transfer-statement",
    formatVersion: 1,
    archiveDigest: await sha256Digest(archive),
    exportId: manifest.exportId,
    subject: manifest.subject,
    consentId: consent.id,
    consentDigest: await consentGrantDigest(consent),
    source: consent.source,
    destination: consent.destination,
    issuedAt: now.toISOString(),
  };
  return { archive, consent, signature: await signEnvelope(identity, "student-transfer", statement) };
}

/** The media type of a learner-carried transfer file. */
export const TRANSFER_FILE_MEDIA_TYPE = "application/vnd.educateos.transfer+json";

/** The largest transfer file or direct push body accepted, in bytes. */
export const MAX_TRANSFER_BYTES = 96 * 1024 * 1024;

/** A transfer package on the wire: the learner's downloaded file, or a direct push's body. */
export const TransferWire = z.strictObject({
  format: recordFormat("transfer"),
  formatVersion: z.literal(1),
  /** The `.educateos` archive, base64url. */
  archive: z.string().min(1),
  consent: TransferConsent,
  signature: SignedEnvelope.optional(),
});
/** A transfer package on the wire. */
export type TransferWire = z.infer<typeof TransferWire>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Encodes a package for the wire. */
export function encodeTransfer(pkg: TransferPackage): Uint8Array<ArrayBuffer> {
  const wire: TransferWire = {
    format: "educateos.transfer",
    formatVersion: 1,
    archive: toBase64Url(pkg.archive),
    consent: pkg.consent,
    ...(pkg.signature === undefined ? {} : { signature: pkg.signature }),
  };
  return encoder.encode(JSON.stringify(wire));
}

/** Decodes a package from the wire, rejecting anything oversized or malformed with `validation-failed`. */
export function decodeTransfer(bytes: Uint8Array<ArrayBuffer>): TransferPackage {
  if (bytes.byteLength > MAX_TRANSFER_BYTES) throw new EducateOsError("validation-failed", "This transfer is too large.");
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new EducateOsError("validation-failed", "This is not a EducateOS transfer file.");
  }
  const parsed = TransferWire.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", "This is not a EducateOS transfer file.");
  const { archive, consent, signature } = parsed.data;
  return { archive: fromBase64Url(archive), consent, ...(signature === undefined ? {} : { signature }) };
}
