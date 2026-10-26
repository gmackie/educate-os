import { z } from "zod";
import { ContentDigest, EducateOsError } from "@educateos/contracts";
import { Ed25519PublicKey, parseWire, signEnvelope, SignedEnvelope, verifyEnvelope, type SigningIdentity } from "@educateos/fleet";
import { ExportId, SubjectRef } from "./archive.ts";
import { consentGrantDigest, sameParty, TransferConsent, TransferConsentId, TransferParty } from "./consent.ts";
import { recordFormat } from "./legacy-formats.ts";

/** A source district whose agent key the destination admin has pinned. */
export const PinnedSource = z.strictObject({
  label: TransferParty.shape.label,
  instanceId: TransferParty.shape.instanceId,
  publicKey: Ed25519PublicKey,
});
/** A pinned source. */
export type PinnedSource = z.infer<typeof PinnedSource>;

/**
 * The pinned entries for a source. A source counts as pinned if either its label or its instance
 * ID is, so a message cannot dodge the signature requirement by claiming a pinned district's name
 * under another instance ID, or the reverse.
 */
export function pinnedFor(pinnedSources: readonly PinnedSource[], source: TransferParty): PinnedSource[] {
  return pinnedSources.filter((p) => p.label === source.label || (p.instanceId !== undefined && p.instanceId === source.instanceId));
}

/**
 * What the source district signs when a consent is withdrawn: which consent (by ID and the digest
 * of its grant), for which export and learner pseudonym, between which districts, and when. A
 * destination that holds it refuses the consent whatever copy of it arrives, which closes the gap a
 * learner-carried file leaves: the file carries the consent as it was when it was downloaded.
 */
export const ConsentRevocationNotice = z.strictObject({
  format: recordFormat("consent-revocation"),
  formatVersion: z.literal(1),
  consentId: TransferConsentId,
  consentDigest: ContentDigest,
  exportId: ExportId,
  subject: SubjectRef,
  source: TransferParty,
  destination: TransferParty,
  revokedAt: z.iso.datetime(),
});
/** A consent revocation notice. */
export type ConsentRevocationNotice = z.infer<typeof ConsentRevocationNotice>;

/**
 * Signs the notice that `consent` was revoked, at the source district, with its fleet agent
 * identity as a `consent-revocation` message. The consent must already be revoked
 * (`revokeTransferConsent`).
 */
export async function issueConsentRevocationNotice(identity: SigningIdentity, rawConsent: TransferConsent): Promise<SignedEnvelope> {
  const consent = TransferConsent.parse(rawConsent);
  if (consent.revokedAt === undefined) throw new EducateOsError("validation-failed", "Only a revoked consent has a revocation notice.");
  const notice: ConsentRevocationNotice = {
    format: "educateos.consent-revocation",
    formatVersion: 1,
    consentId: consent.id,
    consentDigest: await consentGrantDigest(consent),
    exportId: consent.exportId,
    subject: consent.subject,
    source: consent.source,
    destination: consent.destination,
    revokedAt: consent.revokedAt,
  };
  return signEnvelope(identity, "consent-revocation", notice);
}

/** Where a destination keeps the verified revocation notices it has received. The importer checks it before every import. */
export interface ConsentRevocationList {
  /** Records a verified notice. Recording the same consent's notice again keeps the first. */
  record(notice: ConsentRevocationNotice): Promise<void>;
  /** The notice recorded for the consent `consentId` from `source`, if any. */
  find(source: TransferParty, consentId: TransferConsentId): Promise<ConsentRevocationNotice | undefined>;
}

/** A {@link ConsentRevocationList} held in memory, for tests and the local harness. */
export class InMemoryConsentRevocationList implements ConsentRevocationList {
  readonly #notices: ConsentRevocationNotice[] = [];

  async record(notice: ConsentRevocationNotice): Promise<void> {
    const parsed = ConsentRevocationNotice.parse(notice);
    if (this.#notices.some((n) => n.consentId === parsed.consentId && sameParty(n.source, parsed.source))) return;
    this.#notices.push(parsed);
  }

  async find(source: TransferParty, consentId: TransferConsentId): Promise<ConsentRevocationNotice | undefined> {
    const notice = this.#notices.find((n) => n.consentId === consentId && sameParty(n.source, source));
    return notice === undefined ? undefined : structuredClone(notice);
  }
}

/** What accepting a revocation notice checks it against: the destination's own party and pinned sources. */
export interface RevocationAcceptance {
  /** This district, as consents name it. */
  self: TransferParty;
  /** The sources whose keys the destination admin pinned. Only they can revoke. */
  pinnedSources: readonly PinnedSource[];
  /** Where accepted notices are kept. */
  revocations: ConsentRevocationList;
}

/**
 * Verifies and records a revocation notice at the destination. It is accepted only as a
 * `consent-revocation` message signed by a key pinned for the notice's source, and only for a
 * consent to this district; anything else is refused and nothing is recorded. An unpinned source
 * cannot revoke here, just as it cannot sign a transfer the destination would verify.
 */
export async function acceptConsentRevocationNotice(acceptance: RevocationAcceptance, rawEnvelope: unknown): Promise<ConsentRevocationNotice> {
  const envelope = parseWire(SignedEnvelope, rawEnvelope, "revocation notice");
  const notice = parseWire(ConsentRevocationNotice, envelope.payload, "revocation notice");
  const pinned = pinnedFor(acceptance.pinnedSources, notice.source);
  if (pinned.length === 0) throw new EducateOsError("forbidden", "Revocation notices are accepted only from pinned districts.");
  let verified = false;
  for (const source of pinned) {
    if (await verifyEnvelope(envelope, "consent-revocation", source.publicKey)) verified = true;
  }
  if (!verified) throw new EducateOsError("forbidden", "This revocation notice's signature is not valid.");
  if (!sameParty(notice.destination, acceptance.self)) throw new EducateOsError("forbidden", "This revocation notice is for another district.");
  await acceptance.revocations.record(notice);
  return notice;
}
