import { ReleaseOffer, type SignedEnvelope, signEnvelope, type SigningIdentity } from "@schoolos/fleet";
import { ReleaseManifestStatement } from "./manifest.ts";
import { KeyAnnouncement, signReleaseMessage } from "./trust.ts";

/**
 * The root's release-signing key, used by the private root service and in tests. It signs release
 * manifest statements, the offers that carry them, and the announcement that hands signing over to
 * a new key. Every payload is parsed before it is signed, so the root can only sign well-formed
 * statements.
 */
export class RootReleaseSigner {
  #identity: SigningIdentity;

  constructor(identity: SigningIdentity) {
    this.#identity = identity;
  }

  /** The key now signing. */
  get identity(): SigningIdentity {
    return this.#identity;
  }

  /** Signs a release manifest statement. */
  async signManifest(statement: ReleaseManifestStatement): Promise<SignedEnvelope> {
    return await signReleaseMessage(this.#identity, "release-manifest", ReleaseManifestStatement.parse(statement));
  }

  /** Signs a release offer, in the fleet protocol's `release-offer` context. */
  async signOffer(offer: ReleaseOffer): Promise<SignedEnvelope> {
    return await signEnvelope(this.#identity, "release-offer", ReleaseOffer.parse(offer));
  }

  /**
   * Hands signing over to `next`. Returns the announcement, signed by the current key, that
   * districts accept to trust `next`; the current key stays trusted until `signerRetiresAt`, the
   * overlap during which releases signed by either key verify. From now on this signer signs with
   * `next`.
   */
  async rotate(next: SigningIdentity, announcedAt: Date, signerRetiresAt: Date): Promise<SignedEnvelope> {
    const announcement = KeyAnnouncement.parse({
      keyId: next.keyId,
      publicKey: next.publicKey,
      announcedAt: announcedAt.toISOString(),
      signerRetiresAt: signerRetiresAt.toISOString(),
    });
    const envelope = await signReleaseMessage(this.#identity, "release-key-announcement", announcement);
    this.#identity = next;
    return envelope;
  }
}
