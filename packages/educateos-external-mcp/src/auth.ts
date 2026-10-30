import { decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { VerifiedIdentity, VerifiedPrincipal } from "@educateos/contracts";
import type { PrincipalResolver } from "@educateos/identity";

/** An opaque grant contains identity only; district roles are never cached in tokens. */
export interface AccessGrant {
  identity: VerifiedIdentity;
  expiresAt: number;
  /** OAuth scopes copied only from the verified assertion. */
  scopes?: string[];
}

/** Durable, shared storage required across all Worker isolates. Never implement claim as get/put. */
export interface TokenStore {
  /** Atomically claims (issuer,jti) until expiry. False means the assertion was already used. */
  claimAssertion(key: string, expiresAt: number): Promise<boolean>;
  /** Stores a grant keyed by SHA-256 of its bearer secret. */
  putAccess(digest: string, grant: AccessGrant): Promise<void>;
  /** Undefined includes revoked and unknown grants. */
  getAccess(digest: string): Promise<AccessGrant | undefined>;
}

/** Explicit trust, independent of any unverified token URL, role, district or email claim. */
export interface IssuerTrust {
  issuer: string;
  audience: string;
  exchangeAudience: string;
  keys: JWTVerifyGetKey;
  algorithms: readonly string[];
  credential: VerifiedIdentity["credential"];
}

/** Verifies signed access JWTs or exchanged opaque grants and resolves the current district link. */
export class SchoolTokenAuthority {
  readonly #options;
  constructor(options: {
    issuers: readonly IssuerTrust[];
    store: TokenStore;
    /** Must reload the district directory on every call, including after token exchange. */
    resolver: () => Promise<PrincipalResolver>;
    now?: () => number;
    /** Scopes required in both direct JWTs and exchanged grants. */
    requiredScopes?: readonly string[];
  }) {
    this.#options = { ...options, now: options.now ?? Date.now };
    for (const trust of options.issuers) {
      if (
        !trust.audience ||
        !trust.exchangeAudience ||
        trust.audience === trust.exchangeAudience ||
        trust.algorithms.length === 0 ||
        trust.algorithms.some((a) => !/^(RS|PS|ES)\d+$|^EdDSA$/.test(a))
      ) {
        throw new Error("Explicit asymmetric algorithms and distinct token audiences are required");
      }
    }
    if (new Set(options.issuers.map((t) => t.issuer)).size !== options.issuers.length)
      throw new Error("Duplicate issuer");
  }

  async #verify(token: string, exchange: boolean) {
    const issuer = decodeJwt(token).iss;
    const trust = this.#options.issuers.find((t) => t.issuer === issuer);
    if (trust === undefined) throw new Error("Untrusted issuer");
    const { payload } = await jwtVerify(token, trust.keys, {
      issuer: trust.issuer,
      audience: exchange ? trust.exchangeAudience : trust.audience,
      algorithms: [...trust.algorithms],
      typ: exchange ? "JWT" : "at+jwt",
      requiredClaims: ["sub", "iat", "exp", ...(exchange ? ["jti"] : [])],
      currentDate: new Date(this.#options.now()),
    });
    if (
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.iat > this.#options.now() / 1000 ||
      payload.exp! - payload.iat! > 300
    )
      throw new Error("Invalid lifetime");
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
    this.#requireScopes(scopes);
    return {
      scopes,
      identity: { issuer: trust.issuer, subject: payload.sub!, credential: trust.credential },
      payload,
    };
  }

  #requireScopes(scopes: readonly string[]) {
    if (this.#options.requiredScopes?.some((scope) => !scopes.includes(scope)))
      throw new Error("Insufficient scope");
  }

  /** Throws on any invalid, expired, revoked, unlinked or cross-district credential. */
  async authenticate(token: string): Promise<VerifiedPrincipal> {
    let identity: VerifiedIdentity;
    if (token.startsWith("edu_")) {
      const grant = await this.#options.store.getAccess(await digest(token));
      if (grant === undefined || grant.expiresAt <= this.#options.now())
        throw new Error("Invalid grant");
      this.#requireScopes(grant.scopes ?? []);
      identity = grant.identity;
      if (
        !this.#options.issuers.some(
          (trust) => trust.issuer === identity.issuer && trust.credential === identity.credential,
        )
      ) {
        throw new Error("Revoked issuer");
      }
    } else {
      ({ identity } = await this.#verify(token, false));
    }
    const resolved = await (await this.#options.resolver()).resolve(identity);
    return { principalId: resolved.principalId, districtId: resolved.districtId };
  }

  /** Exchanges a short-lived signed assertion once; failure never reveals identity or token claims. */
  async exchange(assertion: string) {
    const { identity, payload, scopes } = await this.#verify(assertion, true);
    await (await this.#options.resolver()).resolve(identity);
    if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 255)
      throw new Error("Invalid assertion ID");
    const expiresAt = Math.min(payload.exp! * 1000, this.#options.now() + 300_000);
    if (
      !(await this.#options.store.claimAssertion(
        JSON.stringify([identity.issuer, payload.jti]),
        payload.exp! * 1000,
      ))
    ) {
      throw new Error("Replayed assertion");
    }
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const accessToken = `edu_${Array.from(secret, (v) => v.toString(16).padStart(2, "0")).join("")}`;
    await this.#options.store.putAccess(await digest(accessToken), { identity, expiresAt, scopes });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      scope: scopes.join(" "),
      expires_in: Math.floor((expiresAt - this.#options.now()) / 1000),
    };
  }
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
}
