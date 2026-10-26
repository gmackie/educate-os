// Issuer presets for the OIDC fake, each following its vendor's published discovery document and
// claim documentation:
// - Clever: https://clever.com/.well-known/openid-configuration, https://dev.clever.com/docs/oidc-implementation,
//   https://dev.clever.com/docs/oauth-implementation, https://dev.clever.com/docs/the-userinfo-endpoint
// - ClassLink: https://launchpad.classlink.com/.well-known/openid-configuration
// - Google: https://accounts.google.com/.well-known/openid-configuration,
//   https://developers.google.com/identity/openid-connect/openid-connect
import { cleverDistrictId, cleverLegacyId, cleverUserId } from "../clever/ids.ts";
import { cleverRoleOf } from "../clever/model.ts";
import { numericId } from "../ids.ts";
import { usernameOf } from "../seed.ts";
import type { DistrictSeed, PersonSeed } from "../types.ts";

/** Who is signing in, to which client, with which scopes. */
export interface OidcUserContext {
  readonly seed: DistrictSeed;
  readonly person: PersonSeed;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

/** An issuer's wire behaviour: endpoints, claims, token response and lifetimes. */
export interface OidcPreset {
  /** A short name, used in key IDs and token prefixes. */
  readonly name: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly userinfoEndpoint: string;
  /** Discovery fields beyond `issuer` and the four endpoints. */
  readonly discovery: Readonly<Record<string, unknown>>;
  /** PKCE methods accepted. A `code_challenge` is honoured on every preset when sent. */
  readonly pkceMethods: readonly ("S256" | "plain")[];
  /** Whether the authorization response carries `iss` (RFC 9207). */
  readonly issInAuthorizationResponse: boolean;
  /** Whether the token endpoint also takes a JSON body (Clever does). */
  readonly acceptsJsonTokenRequest: boolean;
  readonly codeLifetimeSeconds: number;
  readonly accessTokenLifetimeSeconds: number;
  readonly idTokenLifetimeSeconds: number;
  /** The prefix of issued access tokens. */
  readonly accessTokenPrefix: string;
  /** The `error_description` for an `invalid_grant` on a bad code. */
  readonly invalidGrantDescription: string;
  /** The person's subject identifier at this issuer. */
  subjectOf(seed: DistrictSeed, person: PersonSeed): string;
  /** The id_token's claims beyond iss, aud, sub, iat, exp, nonce and at_hash. */
  idTokenClaims(context: OidcUserContext): Record<string, unknown>;
  /** The userinfo response body. */
  userinfo(context: OidcUserContext): Record<string, unknown>;
  /** The token endpoint's success body from its parts. */
  tokenResponse(parts: { accessToken: string; idToken: string; expiresIn: number; scope: string }): Record<string, unknown>;
  /** A claims set broken the way this vendor's goes wrong, for the `malformed-record` fault. */
  malform(claims: Record<string, unknown>): Record<string, unknown>;
}

/** The names of the built-in presets. */
export type OidcPresetName = "clever" | "classlink" | "google";

function has(context: OidcUserContext, scope: string): boolean {
  return context.scopes.includes(scope);
}

function without(claims: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _gone, ...rest } = claims;
  return rest;
}

/** The Clever `user_type` of a person's sign-in role. */
export function cleverUserType(person: PersonSeed): string {
  return cleverRoleOf(person);
}

const cleverPreset: OidcPreset = {
  name: "clever",
  issuer: "https://clever.com",
  authorizationEndpoint: "https://clever.com/oauth/authorize",
  tokenEndpoint: "https://clever.com/oauth/tokens",
  jwksUri: "https://clever.com/oauth/certs",
  userinfoEndpoint: "https://api.clever.com/userinfo",
  discovery: {
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    claims_supported: [
      "iss",
      "sub",
      "aud",
      "iat",
      "exp",
      "user_id",
      "user_type",
      "district_id",
      "multi_role_user_id",
      "email",
      "email_verified",
      "given_name",
      "family_name",
    ],
  },
  pkceMethods: ["S256"],
  issInAuthorizationResponse: false,
  acceptsJsonTokenRequest: true,
  // "Authorization codes are valid for one minute"; "Tokens expire after 24 hours"; id_token
  // `exp` is "one hour after token creation" (oauth-implementation, oidc-implementation).
  codeLifetimeSeconds: 60,
  accessTokenLifetimeSeconds: 24 * 3600,
  idTokenLifetimeSeconds: 3600,
  accessTokenPrefix: "",
  invalidGrantDescription: "Invalid grant: invalid code",
  subjectOf: (seed, person) => cleverUserId(seed, person.id),
  idTokenClaims: (context) => {
    const { seed, person } = context;
    const role = cleverRoleOf(person);
    return {
      user_id: cleverLegacyId(seed, person.id, role),
      user_type: cleverUserType(person),
      district: cleverDistrictId(seed),
      multi_role_user_id: cleverUserId(seed, person.id),
      ...(has(context, "email") ? { email: person.email, email_verified: false } : {}),
      ...(has(context, "profile") ? { given_name: person.givenName, family_name: person.familyName } : {}),
    };
  },
  userinfo: (context) => {
    const { seed, person } = context;
    const role = cleverRoleOf(person);
    return {
      sub: cleverUserId(seed, person.id),
      user_id: cleverLegacyId(seed, person.id, role),
      multi_role_user_id: cleverUserId(seed, person.id),
      user_type: cleverUserType(person),
      district_id: cleverDistrictId(seed),
      district: cleverDistrictId(seed),
      email: person.email,
      email_verified: false,
      name: { first: person.givenName, last: person.familyName, middle: person.middleName ?? "" },
      given_name: person.givenName,
      family_name: person.familyName,
      schools: [],
      authorized_by: "district",
    };
  },
  tokenResponse: ({ accessToken, idToken }) => ({ access_token: accessToken, id_token: idToken, token_type: "bearer" }),
  // Clever claims go wrong by a missing district: an app keyed on district cannot place the user.
  malform: (claims) => without(without(claims, "district"), "district_id"),
};

/** A seed person's ClassLink user ID (`sub`, `UserId`). */
export function classlinkUserId(seed: Pick<DistrictSeed, "id">, personId: string): string {
  return numericId("classlink:user", `${seed.id}\u0000${personId}`, 8);
}

/** A seed district's ClassLink tenant ID. */
export function classlinkTenantId(seed: Pick<DistrictSeed, "id">): string {
  return numericId("classlink:tenant", seed.id, 4);
}

const CLASSLINK_ROLE: Record<PersonSeed["role"], readonly [string, number]> = {
  administrator: ["Tenant Administrator", 1],
  staff: ["Staff", 2],
  teacher: ["Teacher", 3],
  student: ["Student", 4],
  guardian: ["Parent", 5],
};

const classlinkPreset: OidcPreset = {
  name: "classlink",
  issuer: "https://launchpad.classlink.com",
  authorizationEndpoint: "https://launchpad.classlink.com/oauth2/v2/auth",
  tokenEndpoint: "https://launchpad.classlink.com/oauth2/v2/token",
  jwksUri: "https://launchpad.classlink.com/oauth2/v2/jwks",
  userinfoEndpoint: "https://nodeapi.classlink.com/v2/my/profileinfo",
  discovery: {
    acr_values_supported: ["onelogin:nist:level:1:re-auth"],
    response_types_supported: ["code", "id_token", "id_token token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "address", "email", "profile", "oneroster", "classes", "classes.readonly", "inbox", "inbox.readonly", "files", "files.readonly", "admin", "full", "ssf.manage"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    claims_parameter_supported: true,
    claims_supported: [
      "sub",
      "given_name",
      "middle_name",
      "family_name",
      "preferred_username",
      "email",
      "email_verified",
      "profile",
      "phone_number_verified",
      "picture",
      "address",
      "classLink_tenant_id",
      "classLink_tenant_id_string",
      "classLink_role",
      "classLink_role_level",
      "classLink_sourcedId",
      "classLink_org_sourcedids",
      "or_email",
    ],
  },
  pkceMethods: ["S256"],
  issInAuthorizationResponse: false,
  acceptsJsonTokenRequest: false,
  codeLifetimeSeconds: 600,
  accessTokenLifetimeSeconds: 3600,
  idTokenLifetimeSeconds: 3600,
  accessTokenPrefix: "",
  invalidGrantDescription: "Invalid authorization code",
  subjectOf: (seed, person) => classlinkUserId(seed, person.id),
  idTokenClaims: (context) => {
    const { seed, person } = context;
    const [role, level] = CLASSLINK_ROLE[person.role];
    return {
      classLink_tenant_id: Number(classlinkTenantId(seed)),
      classLink_tenant_id_string: classlinkTenantId(seed),
      classLink_role: role,
      classLink_role_level: level,
      // The SIS sourcedId, the same one OneRoster serves: the seed's own ID.
      classLink_sourcedId: person.id,
      classLink_org_sourcedids: person.schoolIds.join(","),
      or_email: person.email,
      ...(has(context, "email") ? { email: person.email, email_verified: true } : {}),
      ...(has(context, "profile")
        ? { given_name: person.givenName, family_name: person.familyName, preferred_username: usernameOf(person), ...(person.middleName === undefined ? {} : { middle_name: person.middleName }) }
        : {}),
    };
  },
  userinfo: ({ seed, person }) => {
    const [role, level] = CLASSLINK_ROLE[person.role];
    return {
      UserId: Number(classlinkUserId(seed, person.id)),
      TenantId: Number(classlinkTenantId(seed)),
      StateId: 0,
      BuildingId: 0,
      AuthenticationType: 2,
      DisplayName: `${person.givenName} ${person.familyName}`,
      FirstName: person.givenName,
      LastName: person.familyName,
      Email: person.email,
      LoginId: usernameOf(person),
      ImagePath: "",
      LanguageId: 1,
      Language: "en",
      DefaultTimeFormat: 0,
      Tenant: seed.name,
      Building: "",
      Role: role,
      Role_Level: level,
      SourcedId: person.id,
      OrgSourcedIds: person.schoolIds,
    };
  },
  tokenResponse: ({ accessToken, idToken, expiresIn, scope }) => ({ access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, id_token: idToken, scope }),
  // ClassLink data goes wrong by a missing SIS link: no sourcedId to match the roster on.
  malform: (claims) => without(without(claims, "classLink_sourcedId"), "SourcedId"),
};

/** A seed person's Google account ID (`sub`): 21 decimal digits. */
export function googleSubjectId(seed: Pick<DistrictSeed, "id">, personId: string): string {
  return numericId("google:user", `${seed.id}\u0000${personId}`, 21);
}

const googlePreset: OidcPreset = {
  name: "google",
  issuer: "https://accounts.google.com",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
  userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  discovery: {
    device_authorization_endpoint: "https://oauth2.googleapis.com/device/code",
    revocation_endpoint: "https://oauth2.googleapis.com/revoke",
    response_types_supported: ["code", "token", "id_token", "code token", "code id_token", "token id_token", "code token id_token", "none"],
    response_modes_supported: ["query", "fragment", "form_post"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    claims_supported: ["aud", "email", "email_verified", "exp", "family_name", "given_name", "iat", "iss", "name", "picture", "sub"],
    code_challenge_methods_supported: ["plain", "S256"],
    grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
    authorization_response_iss_parameter_supported: true,
  },
  pkceMethods: ["S256", "plain"],
  issInAuthorizationResponse: true,
  acceptsJsonTokenRequest: false,
  codeLifetimeSeconds: 600,
  accessTokenLifetimeSeconds: 3599,
  idTokenLifetimeSeconds: 3600,
  accessTokenPrefix: "ya29.",
  invalidGrantDescription: "Bad Request",
  subjectOf: (seed, person) => googleSubjectId(seed, person.id),
  idTokenClaims: (context) => {
    const { seed, person, clientId } = context;
    return {
      azp: clientId,
      // A Workspace account carries its hosted domain.
      hd: seed.domain,
      ...(has(context, "email") ? { email: person.email, email_verified: true } : {}),
      ...(has(context, "profile") ? { name: `${person.givenName} ${person.familyName}`, given_name: person.givenName, family_name: person.familyName } : {}),
    };
  },
  userinfo: (context) => {
    const { seed, person } = context;
    return {
      sub: googleSubjectId(seed, person.id),
      ...(has(context, "profile") ? { name: `${person.givenName} ${person.familyName}`, given_name: person.givenName, family_name: person.familyName } : {}),
      ...(has(context, "email") ? { email: person.email, email_verified: true } : {}),
      hd: seed.domain,
    };
  },
  tokenResponse: ({ accessToken, idToken, expiresIn, scope }) => ({ access_token: accessToken, expires_in: expiresIn, scope, token_type: "Bearer", id_token: idToken }),
  // Google's historical slip: `email_verified` as the string "true" rather than a boolean.
  malform: (claims) => ({ ...claims, email_verified: "true" }),
};

/** The built-in presets. Spread one to make a variant: `{ ...OIDC_PRESETS.google, issuer: … }`. */
export const OIDC_PRESETS: Readonly<Record<OidcPresetName, OidcPreset>> = {
  clever: cleverPreset,
  classlink: classlinkPreset,
  google: googlePreset,
};
