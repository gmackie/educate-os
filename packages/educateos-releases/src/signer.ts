import { ReleaseOffer, type SignedEnvelope, signEnvelope, type SigningIdentity } from "@educateos/fleet";
import { ReleaseManifestStatement } from "./manifest.ts";
import { signReleaseMessage } from "./trust.ts";

/**
 * The root's online release-signing key, used by the private root service and in tests. It signs
 * release manifest statements and the offers that carry them. Every payload is parsed before it is
 * signed, so the root can only sign well-formed statements. It can't change which keys districts
 * trust: that takes a release key set signed by the offline root keys (`signReleaseKeySet`).
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
   * Signs with `next` from now on. Call it once a release key set that lists `next` has been
   * published; until districts accept that set, what `next` signs doesn't verify for them.
   */
  useKey(next: SigningIdentity): void {
    this.#identity = next;
  }
}
