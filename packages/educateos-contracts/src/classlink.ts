import { z } from "zod";

// ClassLink's own facts as configuration, not code: no live ClassLink tenant has been seen yet
// (SCHO-204, SCHO-211), so every value ClassLink's documentation left open can be changed per
// district without a release. The defaults follow ClassLink's published discovery document and
// districts' Roster Server setup guides; docs/educateos/maturity.md lists what is inferred.

/** A ClassLink tenant ID: the number ClassLink's `classLink_tenant_id` claim carries. */
export const ClassLinkTenantId = z.string().regex(/^\d{1,12}$/, "is a ClassLink tenant number");
/** A ClassLink tenant ID. */
export type ClassLinkTenantId = z.infer<typeof ClassLinkTenantId>;

/** The OneRoster 1.2 scope that grants read access to the core rostering collections. */
export const CLASSLINK_DEFAULT_ROSTER_SCOPE = "https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly";

// An RFC 6749 section 3.3 scope token: printable ASCII except space, `"` and `\`.
const ScopeToken = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, "is not an OAuth scope token");

/** How a client authenticates to a token endpoint (RFC 6749 section 2.3.1). */
export const OAuthClientAuthentication = z.enum(["client_secret_basic", "client_secret_post"]);
/** A token endpoint client authentication method. */
export type OAuthClientAuthentication = z.infer<typeof OAuthClientAuthentication>;

/**
 * A district's ClassLink Roster Server: its OneRoster 1.2 REST API under OAuth 2.0 client
 * credentials. The client ID and secret are Worker secrets, never configuration.
 */
export const ClassLinkRosterConnection = z.strictObject({
  /** The district's tenant. */
  tenantId: ClassLinkTenantId,
  /** The Roster Server's base URL, below which the rostering service lives. */
  serverUrl: z.url({ protocol: /^https$/ }),
  /** The token endpoint's path on the server. District setup guides give `/token`. */
  tokenPath: z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/, "is an absolute path").default("/token"),
  /** The scopes to request. */
  scopes: z.array(ScopeToken).min(1).max(20).default([CLASSLINK_DEFAULT_ROSTER_SCOPE]),
  /** How the client authenticates to the token endpoint. */
  clientAuthentication: OAuthClientAuthentication.default("client_secret_basic"),
});
/** A ClassLink roster connection, as given. */
export type ClassLinkRosterConnectionInput = z.input<typeof ClassLinkRosterConnection>;
/** A ClassLink roster connection. */
export type ClassLinkRosterConnection = z.infer<typeof ClassLinkRosterConnection>;

/**
 * Which id_token claim is the subject the district's roster links each person to. `sub` is the
 * ClassLink user ID; `preferred_username` is the login ID, which the roster carries as `username`.
 * Email is not an option: it is not a stable or unique key (ADR-0003).
 */
export const ClassLinkSubjectClaim = z.enum(["sub", "preferred_username"]);
/** A ClassLink subject claim. */
export type ClassLinkSubjectClaim = z.infer<typeof ClassLinkSubjectClaim>;

/**
 * ClassLink sign-in (OpenID Connect) for a district. The issuer must be one the district trusts.
 * The relying party's client secret is a Worker secret, never configuration.
 */
export const ClassLinkSso = z.strictObject({
  /** The district's tenant. A token from any other tenant is refused, whatever its subject. */
  tenantId: ClassLinkTenantId,
  /** The `iss` ClassLink's tokens carry. */
  issuer: z.url({ protocol: /^https$/ }).default("https://launchpad.classlink.com"),
  /** The relying party's client ID, which id_tokens carry as `aud`. */
  clientId: z.string().min(1).max(255),
  /** Where the subject is. */
  subjectClaim: ClassLinkSubjectClaim,
  /** The claim carrying the tenant ID, which ClassLink documents as `classLink_tenant_id`. */
  tenantClaim: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).default("classLink_tenant_id"),
  /** The scopes to request. `profile` carries `preferred_username`. */
  scopes: z.array(ScopeToken).min(1).max(20).default(["openid", "profile"]),
  /** How the client authenticates to the token endpoint. */
  clientAuthentication: OAuthClientAuthentication.default("client_secret_basic"),
  /**
   * The endpoints, under their OIDC discovery names, from ClassLink's discovery document. (Not
   * `token`: a field named for a token reads as a credential to the configuration's secret scan.)
   */
  endpoints: z.strictObject({
    authorizationEndpoint: z.url({ protocol: /^https$/ }),
    tokenEndpoint: z.url({ protocol: /^https$/ }),
    jwksUri: z.url({ protocol: /^https$/ }),
  }).default({
    authorizationEndpoint: "https://launchpad.classlink.com/oauth2/v2/auth",
    tokenEndpoint: "https://launchpad.classlink.com/oauth2/v2/token",
    jwksUri: "https://launchpad.classlink.com/oauth2/v2/jwks",
  }),
});
/** ClassLink sign-in, as given. */
export type ClassLinkSsoInput = z.input<typeof ClassLinkSso>;
/** ClassLink sign-in. */
export type ClassLinkSso = z.infer<typeof ClassLinkSso>;
