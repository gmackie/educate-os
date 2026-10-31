import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { EducateOsError, type DelegationId, type VerifiedPrincipal } from "@educateos/contracts";
import type { PrincipalResolver } from "@educateos/identity";
import { delegationInForce, type DelegationStore } from "@educateos/policy";

// The district `/mcp` as an OAuth protected resource (SCHO-174). The authorization server is the
// district's configured issuer (Nathan, NATH-6); this module only checks the access tokens it
// issues and decides, from district records alone, who the caller is and which delegation bounds
// it. Nothing in a token names a role, a principal, a district or a delegation.

/** The issuer whose access tokens a district `/mcp` accepts, from trusted deployment configuration. */
export interface ResourceIssuer {
  /** The issuer URL, compared exactly with `iss`. */
  issuer: string;
  /** Its signing keys, from a JWKS URL in configuration: never a URL a token header names. */
  keys: JWTVerifyGetKey;
  /** The asymmetric algorithms it signs with. */
  algorithms: readonly string[];
}

/** What a {@link DelegatedResourceAuthority} is built from. */
export interface DelegatedResourceAuthorityOptions {
  /** The resource's exact URL, `https://<district>/mcp`: the only audience accepted (RFC 8707). */
  resource: string;
  /** The one trusted issuer. */
  issuer: ResourceIssuer;
  /** Scopes every token must carry, such as `mcp:tools`. A scope opens the transport and nothing more. */
  requiredScopes: readonly string[];
  /** Must read the current directory on every call, so an unlinked or deactivated principal stops at once. */
  resolver: () => Promise<PrincipalResolver>;
  /** The district's delegations (IF-06), read on every call. */
  delegations: Pick<DelegationStore, "list">;
  /** The longest token lifetime accepted, `exp - iat`. Defaults to {@link MAX_ACCESS_TOKEN_SECONDS}. */
  maxLifetimeSeconds?: number;
  /** The clock, in milliseconds. */
  now?: () => number;
}

/** The longest access-token lifetime accepted by default: ten minutes. */
export const MAX_ACCESS_TOKEN_SECONDS = 600;

const CLIENT_ID = /^[\x21-\x7e]{1,255}$/;

/** A caller the transport must refuse with 401: no usable token, or no linked active principal. */
const unauthenticated = () => new EducateOsError("unauthenticated", "The access token was not accepted.");
/** A caller the transport must refuse with 403: a good token whose client acts under no single delegation. */
const forbidden = () => new EducateOsError("forbidden", "No delegation from this person to this client is in force.");

/**
 * Verifies an access JWT from the configured issuer and resolves the delegated subject it acts as.
 *
 * The token must be `typ: at+jwt` (RFC 9068), signed with an allowed algorithm by a configured key,
 * from the exact issuer, for the exact resource as its only audience, unexpired and within its
 * `nbf`, no longer-lived than the maximum, carrying every required scope and a `client_id`. Its
 * `(iss, sub)` resolves to a principal through the district's identity links, and that principal
 * must have issued exactly one delegation in force to the client `(iss, client_id)`. Every check
 * runs on every call, so revoking the delegation, deactivating the principal or unlinking the
 * identity refuses the next request whatever the token's expiry.
 */
export class DelegatedResourceAuthority {
  readonly #options: DelegatedResourceAuthorityOptions & { now: () => number; maxLifetimeSeconds: number };

  constructor(options: DelegatedResourceAuthorityOptions) {
    const { issuer, resource } = options;
    if (issuer.algorithms.length === 0 || issuer.algorithms.some((a) => !/^(RS|PS|ES)(256|384|512)$|^EdDSA$/.test(a))) {
      throw new Error("Explicit asymmetric algorithms are required");
    }
    const url = new URL(resource);
    if (url.protocol !== "https:" || url.pathname !== "/mcp" || url.search || url.hash || url.username || url.password) {
      throw new Error("The resource must be an https URL ending in /mcp");
    }
    if (options.requiredScopes.length === 0) throw new Error("At least one required scope is needed");
    this.#options = { ...options, now: options.now ?? Date.now, maxLifetimeSeconds: options.maxLifetimeSeconds ?? MAX_ACCESS_TOKEN_SECONDS };
  }

  /**
   * The delegated subject `token` acts as.
   *
   * @throws EducateOsError `unauthenticated` for any token, link or principal that is not accepted;
   *   `forbidden` when the principal has no delegation, or more than one, in force to the client.
   */
  async authenticate(token: string): Promise<VerifiedPrincipal & { delegationId: DelegationId }> {
    const { issuer, resource, now } = this.#options;
    let payload;
    try {
      ({ payload } = await jwtVerify(token, issuer.keys, {
        issuer: issuer.issuer,
        audience: resource,
        algorithms: [...issuer.algorithms],
        typ: "at+jwt",
        requiredClaims: ["sub", "iat", "exp", "client_id", "scope"],
        currentDate: new Date(now()),
      }));
    } catch {
      throw unauthenticated();
    }
    const { sub, iat, exp, aud, scope, client_id: clientId } = payload;
    const nowSeconds = now() / 1000;
    if (
      typeof sub !== "string" || sub === "" ||
      typeof iat !== "number" || typeof exp !== "number" ||
      iat > nowSeconds || exp - iat > this.#options.maxLifetimeSeconds ||
      // One audience only: a token minted for several resources is replayable at each of them.
      (Array.isArray(aud) && aud.length !== 1) ||
      typeof clientId !== "string" || !CLIENT_ID.test(clientId) ||
      typeof scope !== "string"
    ) {
      throw unauthenticated();
    }
    const scopes = scope.split(" ").filter(Boolean);
    if (this.#options.requiredScopes.some((required) => !scopes.includes(required))) throw unauthenticated();

    let principal;
    try {
      const resolver = await this.#options.resolver();
      principal = await resolver.resolve({ issuer: issuer.issuer, subject: sub, credential: "person" });
    } catch {
      throw unauthenticated();
    }
    const at = new Date(now());
    const matching = (await this.#options.delegations.list()).filter((delegation) =>
      delegation.districtId === principal.districtId &&
      delegation.grantorPrincipalId === principal.principalId &&
      delegation.client.issuer === issuer.issuer &&
      delegation.client.clientId === clientId &&
      delegationInForce(delegation, at));
    // Two in force would leave the bound to a guess, so neither applies until one is revoked.
    if (matching.length !== 1) throw forbidden();
    return { districtId: principal.districtId, principalId: principal.principalId, delegationId: matching[0]!.id };
  }
}
