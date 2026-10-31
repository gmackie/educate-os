import { EducateOsError, type Authorizer, type Caller, type DistrictId } from "@educateos/contracts";
import { toolJwks, type ToolPublicJwk } from "@educateos/lti";
import { authorizeLti, districtResource } from "./authorize.ts";
import type { TableToolKeyStore, ToolKeyRotation } from "./tool-keys.ts";

/** What {@link LtiPlatformKeyService} is built from. */
export interface LtiPlatformKeyServiceOptions {
  readonly districtId: DistrictId;
  /** The district's policy engine (A02). Every administrator's call is decided by it. */
  readonly authorizer: Authorizer;
  /** The platform's signing keys (`LtiDistrictStores.platformKeys`). */
  readonly keys: TableToolKeyStore;
}

const forbidden = () => new EducateOsError("forbidden", "You may not manage this district's LTI Platform keys.");

/**
 * The keys EducateOS signs with as an LTI Platform (SCHO-179): the public JWKS third-party tools
 * verify launches against, and an administrator's view and rotation of them. Reading the key IDs
 * needs `read` on the district and rotating needs `update` there, as the tool keys do; the JWKS is
 * public, since it holds only public halves.
 */
export class LtiPlatformKeyService {
  readonly #options: LtiPlatformKeyServiceOptions;

  constructor(options: LtiPlatformKeyServiceOptions) {
    this.#options = options;
  }

  /** The platform JWKS: the signing key's public half and every retired key's still published. */
  async jwks(): Promise<{ keys: ToolPublicJwk[] }> {
    return toolJwks(await this.#options.keys.keySet());
  }

  /** The published key IDs, the signing key first. */
  async keyIds(caller: Caller): Promise<readonly string[]> {
    await authorizeLti(this.#options.authorizer, caller, "read", districtResource(this.#options.districtId), forbidden);
    return (await this.jwks()).keys.map((key) => key.kid);
  }

  /** Rotates the platform's signing key; the previous key stays published. */
  async rotate(caller: Caller): Promise<ToolKeyRotation> {
    await authorizeLti(this.#options.authorizer, caller, "update", districtResource(this.#options.districtId), forbidden);
    return this.#options.keys.rotate();
  }
}
