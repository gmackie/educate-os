// LTI Dynamic Registration 1.0, extracted from PlayTrek `packages/lti/src/dynamic-reg/handler.ts`
// and `apps/nextjs/src/app/api/lti/dynamic-registration/route.ts` at commit 7258e4347, with the
// fixes PlayTrek's plan 008 recorded and the ones it left open:
// - PlayTrek's endpoint was first open to anyone; it later took an operator-wide shared secret.
//   Here a district administrator issues a single-use, expiring invitation, so a registration is
//   bound to the district that asked for it.
// - PlayTrek stored the platform and later added a `pending` status the launch route checked. Here
//   a registration is only a `PendingPlatformRegistration` in a separate store the broker never
//   reads; it launches nothing until an administrator approves it with its offering mappings.
// - PlayTrek defaulted a missing `deployment_id` to `""` and parsed loosely (`.loose()`, optional
//   `client_id` fields); here the client ID and deployment ID are required and non-empty and every
//   URL must be https.
// - PlayTrek echoed 200 characters of the platform's error body into its own error; here no
//   platform body is ever repeated, and responses are size-limited and never follow redirects.
// - PlayTrek asked for the platform's default claims; here only `iss` and `sub`, with Canvas's
//   `anonymous` privacy level, so no name or email is ever sent.
import { z } from "zod";
import { DistrictId, PrincipalId, ProviderName, EducateOsError } from "@educateos/contracts";
import { ltiToolEndpoints, type LtiToolEndpoints } from "./broker.ts";
import { CANVAS_PLACEMENTS } from "./canvas.ts";
import type { LaunchMessageType } from "./claims.ts";
import { ActivityLink, OfferingMapping, PlatformRegistration } from "./registration.ts";
import { AGS_SCOPES, LTI_SCOPES, readJson } from "./service-client.ts";
import { randomToken, type Clock, type SingleUseStore } from "./stores.ts";

const LtiId = z.string().min(1).max(255);
const HttpsUrl = z.url({ protocol: /^https$/ });
const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** How long a registration invitation stays usable, in milliseconds. */
export const REGISTRATION_INVITATION_TTL_MS = 60 * 60_000;

/**
 * A district administrator's single-use permission for one platform to register. Its token is part
 * of the registration URL the administrator pastes into the platform, which appends its own
 * `openid_configuration` and `registration_token`.
 */
export const RegistrationInvitation = z.strictObject({
  districtId: DistrictId,
  issuedBy: PrincipalId,
  issuedAt: z.iso.datetime(),
});
/** A registration invitation. */
export type RegistrationInvitation = z.infer<typeof RegistrationInvitation>;

/** Identifies a pending registration. */
export const PendingRegistrationId = z.string().regex(/^lpr_[A-Za-z0-9_-]{24}$/, "expected a pending registration ID (lpr_…)");
/** A pending registration ID. */
export type PendingRegistrationId = z.infer<typeof PendingRegistrationId>;

/**
 * A platform that completed dynamic registration and is waiting for a district administrator.
 * Every field came from the platform, over https, during a registration the district invited. It
 * launches nothing: the broker reads only approved {@link PlatformRegistration}s.
 */
export const PendingPlatformRegistration = z.strictObject({
  id: PendingRegistrationId,
  districtId: DistrictId,
  issuer: HttpsUrl,
  clientId: LtiId,
  /**
   * The deployment the platform created for the tool, when it created one at registration. Canvas
   * creates it later, when the tool is installed in an account or course; the administrator then
   * supplies it on approval.
   */
  deploymentId: LtiId.optional(),
  authLoginUrl: HttpsUrl,
  authTokenUrl: HttpsUrl,
  jwksUrl: HttpsUrl,
  /** The platform's `product_family_code` (`canvas`, `moodle`), shown to the administrator. */
  productFamily: z.string().min(1).max(64).optional(),
  /** Who issued the invitation the platform used. */
  invitedBy: PrincipalId,
  receivedAt: z.iso.datetime(),
});
/** A pending platform registration. */
export type PendingPlatformRegistration = z.infer<typeof PendingPlatformRegistration>;

/** Where pending registrations wait for an administrator. */
export interface PendingRegistrationStore {
  /** Stores a new pending registration. */
  put(pending: PendingPlatformRegistration): Promise<void>;
  /** The pending registration `id`, or `undefined`. */
  get(id: PendingRegistrationId): Promise<PendingPlatformRegistration | undefined>;
  /** Every pending registration. */
  list(): Promise<readonly PendingPlatformRegistration[]>;
  /** Removes a pending registration, once approved or rejected. Returns whether it was there. */
  remove(id: PendingRegistrationId): Promise<boolean>;
}

/** An in-memory {@link PendingRegistrationStore}. */
export class InMemoryPendingRegistrationStore implements PendingRegistrationStore {
  readonly #pending = new Map<string, PendingPlatformRegistration>();

  async put(pending: PendingPlatformRegistration): Promise<void> {
    const parsed = PendingPlatformRegistration.parse(pending);
    if (this.#pending.has(parsed.id)) throw new EducateOsError("conflict", "That pending registration already exists.");
    this.#pending.set(parsed.id, parsed);
  }

  async get(id: PendingRegistrationId): Promise<PendingPlatformRegistration | undefined> {
    return this.#pending.get(id);
  }

  async list(): Promise<readonly PendingPlatformRegistration[]> {
    return [...this.#pending.values()];
  }

  async remove(id: PendingRegistrationId): Promise<boolean> {
    return this.#pending.delete(id);
  }
}

/**
 * What an administrator decides when approving a registration: which system the platform is in the
 * district's authority map, and which of its courses launch into which offerings.
 */
export const RegistrationApproval = z.strictObject({
  provider: ProviderName,
  offerings: z.array(OfferingMapping).min(1),
  activityLinks: z.array(ActivityLink).default([]),
  /**
   * Deployments launches may come through, beyond any the platform reported at registration: the
   * IDs the platform shows once the tool is installed (Canvas creates its deployments then).
   */
  deploymentIds: z.array(LtiId).max(20).default([]),
});
/** A registration approval. */
export type RegistrationApproval = z.input<typeof RegistrationApproval>;

/**
 * The platform registration an approval makes of a pending one. Its deployments are the one the
 * platform reported, if any, and those the approval names; with none at all it is refused, since no
 * launch could be accepted.
 */
export function approvedRegistration(pending: PendingPlatformRegistration, approval: RegistrationApproval): PlatformRegistration {
  const parsedPending = PendingPlatformRegistration.parse(pending);
  const decided = RegistrationApproval.parse(approval);
  const deploymentIds = [...new Set([...(parsedPending.deploymentId === undefined ? [] : [parsedPending.deploymentId]), ...decided.deploymentIds])];
  if (deploymentIds.length === 0) {
    throw new EducateOsError("validation-failed", "The platform reported no deployment: install the tool there, then approve it with the deployment ID the platform shows.");
  }
  return PlatformRegistration.parse({
    districtId: parsedPending.districtId,
    provider: decided.provider,
    issuer: parsedPending.issuer,
    clientId: parsedPending.clientId,
    deploymentIds,
    authLoginUrl: parsedPending.authLoginUrl,
    authTokenUrl: parsedPending.authTokenUrl,
    jwksUrl: parsedPending.jwksUrl,
    offerings: decided.offerings,
    activityLinks: decided.activityLinks,
  });
}

/**
 * The platform's OpenID configuration (Dynamic Registration §3.4). A stripping `z.object`: a
 * platform publishes many members EducateOS has no use for. What is read is required and checked.
 */
const PlatformOpenIdConfiguration = z.object({
  issuer: HttpsUrl,
  authorization_endpoint: HttpsUrl,
  token_endpoint: HttpsUrl,
  jwks_uri: HttpsUrl,
  registration_endpoint: HttpsUrl,
  scopes_supported: z.array(z.string().max(512)).max(256).optional(),
  "https://purl.imsglobal.org/spec/lti-platform-configuration": z
    .object({ product_family_code: z.string().min(1).max(64) })
    .optional(),
});

/**
 * Issuers whose platform is served from hosts other than the issuer's own, with the hosts it is
 * served from. Canvas Cloud's issuer is `https://canvas.instructure.com` for every institution,
 * whose configuration and endpoints live on the institution's `*.instructure.com` host or on
 * `sso.canvaslms.com`. Every other issuer must serve its configuration, keys and endpoints itself.
 */
export const MULTI_HOST_PLATFORMS: Readonly<Record<string, readonly string[]>> = {
  "https://canvas.instructure.com": ["canvas.instructure.com", "*.instructure.com", "sso.canvaslms.com", "*.canvaslms.com"],
};

const hostMatches = (host: string, pattern: string) =>
  pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern;

/**
 * Refuses a platform configuration that names an issuer it is not served by (LTI Dynamic
 * Registration §3.5.1: the issuer must match the configuration's origin). Otherwise anyone holding
 * an invitation could register as a trusted issuer, Canvas Cloud or the district's own sign-in,
 * with keys of their own, and sign launches as anyone linked under that issuer.
 */
export function assertPlatformServedByIssuer(
  configurationUrl: string,
  platform: { issuer: string; jwks_uri: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint: string },
  multiHostPlatforms: Readonly<Record<string, readonly string[]>> = MULTI_HOST_PLATFORMS,
): void {
  const issuer = new URL(platform.issuer);
  const allowed = multiHostPlatforms[issuer.origin] ?? [issuer.host];
  const urls = [configurationUrl, platform.jwks_uri, platform.authorization_endpoint, platform.token_endpoint, platform.registration_endpoint];
  for (const raw of urls) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.port !== issuer.port || !allowed.some((pattern) => hostMatches(url.host, pattern))) {
      throw new EducateOsError("validation-failed", "The platform's configuration names an issuer it is not served from.");
    }
  }
}

/** The platform's answer to the tool's registration request (§3.6). Stripping, as above. */
/**
 * The platform's registration answer (§3.6.2): the client ID it assigned, and a deployment ID if it
 * created a deployment. The specification puts that inside the tool configuration; Canvas puts it at
 * the top level, and only when it creates the deployment at registration. An empty one is refused.
 */
const ToolRegistrationResponse = z.object({
  client_id: LtiId,
  deployment_id: LtiId.optional(),
  "https://purl.imsglobal.org/spec/lti-tool-configuration": z.object({ deployment_id: LtiId.optional() }).optional(),
});

/** The registration request's query string, as the platform opens it. */
const RegistrationQuery = z.strictObject({
  invitation: Token,
  openid_configuration: HttpsUrl,
  registration_token: z.string().min(1).max(4096).optional(),
});

/** The script the completion page runs: it tells the platform to close the registration window. */
export const REGISTRATION_CLOSE_SCRIPT = `(window.opener || window.parent).postMessage({ subject: "org.imsglobal.lti.close" }, "*");`;
/** The CSP source admitting {@link REGISTRATION_CLOSE_SCRIPT}. A test recomputes it. */
export const REGISTRATION_CLOSE_SCRIPT_HASH = "'sha256-2RT0pE4PMvrm8wOmcE1HTqG24b5oTzNBYUgo8bVagAw='";

/** What {@link DynamicRegistration} is built from. */
export interface DynamicRegistrationOptions {
  /** The tool's HTTPS origin. */
  readonly toolOrigin: string;
  /** The name platforms show for the tool. */
  readonly toolName: string;
  readonly invitations: SingleUseStore<RegistrationInvitation>;
  readonly pending: PendingRegistrationStore;
  /** Used for the platform's OpenID configuration and registration endpoint, and nothing else. */
  readonly fetch: typeof globalThis.fetch;
  /**
   * More platforms served from hosts other than their issuer's, by issuer origin, added to
   * {@link MULTI_HOST_PLATFORMS}: a self-hosted LMS split across hosts, say.
   */
  readonly multiHostPlatforms?: Readonly<Record<string, readonly string[]>>;
  readonly now?: Clock;
}

/**
 * LTI Dynamic Registration for one district deployment. An administrator issues an invitation
 * (through the district's admin service, which authorizes them); the platform then opens the
 * invitation's URL, and {@link handle} registers the tool with it and records a
 * {@link PendingPlatformRegistration} for the administrator to approve.
 */
export class DynamicRegistration {
  readonly #options: DynamicRegistrationOptions;
  readonly #endpoints: LtiToolEndpoints;
  readonly #now: Clock;

  constructor(options: DynamicRegistrationOptions) {
    this.#options = options;
    this.#endpoints = ltiToolEndpoints(options.toolOrigin);
    this.#now = options.now ?? Date.now;
  }

  /**
   * Issues a single-use invitation for `districtId`, valid for {@link REGISTRATION_INVITATION_TTL_MS}.
   * The caller must already have authorized `issuedBy` to configure the district's integrations.
   */
  async issueInvitation(districtId: DistrictId, issuedBy: PrincipalId): Promise<{ url: string; expiresAt: string }> {
    const token = randomToken();
    const now = this.#now();
    const expiresAt = now + REGISTRATION_INVITATION_TTL_MS;
    await this.#options.invitations.put(
      token,
      RegistrationInvitation.parse({ districtId, issuedBy, issuedAt: new Date(now).toISOString() }),
      expiresAt,
    );
    const url = new URL(`${this.#options.toolOrigin}/lti/register`);
    url.searchParams.set("invitation", token);
    return { url: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Handles the platform's registration request. Consumes the invitation first, so a URL works
   * once whether or not the platform then succeeds; the administrator issues another to retry.
   */
  async handle(request: Request): Promise<Response> {
    const query = RegistrationQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new EducateOsError("validation-failed", "The registration request is incomplete.");
    const invitation = await this.#options.invitations.take(query.data.invitation);
    if (invitation === undefined) {
      throw new EducateOsError("unauthenticated", "This registration link is unknown, expired or already used.");
    }

    const config = PlatformOpenIdConfiguration.safeParse(
      await this.#fetchJson(query.data.openid_configuration, { method: "GET", headers: { accept: "application/json" } }),
    );
    if (!config.success) throw new EducateOsError("validation-failed", "The platform's configuration is not usable.");
    const platform = config.data;
    assertPlatformServedByIssuer(query.data.openid_configuration, platform, { ...MULTI_HOST_PLATFORMS, ...this.#options.multiHostPlatforms });

    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (query.data.registration_token !== undefined) headers.authorization = `Bearer ${query.data.registration_token}`;
    const registered = ToolRegistrationResponse.safeParse(
      await this.#fetchJson(platform.registration_endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(this.#clientMetadata(platform.scopes_supported)),
      }),
    );
    if (!registered.success) {
      throw new EducateOsError("validation-failed", "The platform's registration answer lacks a client ID, or has an empty deployment ID.");
    }
    const deploymentId = registered.data.deployment_id ?? registered.data["https://purl.imsglobal.org/spec/lti-tool-configuration"]?.deployment_id;

    const productFamily = platform["https://purl.imsglobal.org/spec/lti-platform-configuration"]?.product_family_code;
    await this.#options.pending.put(
      PendingPlatformRegistration.parse({
        id: `lpr_${randomToken().slice(0, 24)}`,
        districtId: invitation.districtId,
        issuer: platform.issuer,
        clientId: registered.data.client_id,
        ...(deploymentId === undefined ? {} : { deploymentId }),
        authLoginUrl: platform.authorization_endpoint,
        authTokenUrl: platform.token_endpoint,
        jwksUrl: platform.jwks_uri,
        ...(productFamily === undefined ? {} : { productFamily }),
        invitedBy: invitation.issuedBy,
        receivedAt: new Date(this.#now()).toISOString(),
      }),
    );
    return new Response(completionPage(), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src ${REGISTRATION_CLOSE_SCRIPT_HASH}; base-uri 'none'`,
      },
    });
  }

  /** The tool's client metadata (§3.6.1). It asks for `iss` and `sub` only: no name, no email. */
  #clientMetadata(scopesSupported: readonly string[] | undefined): Record<string, unknown> {
    const endpoints = this.#endpoints;
    const wanted = [...AGS_SCOPES, LTI_SCOPES.contextMembershipReadonly];
    const scopes = scopesSupported === undefined ? wanted : wanted.filter((scope) => scopesSupported.includes(scope));
    // Every message names its placements: Canvas gives a message without any `link_selection`, and
    // keeps the first message per placement, so the resource link would take Deep Linking's.
    const placementsOf = (type: LaunchMessageType) =>
      Object.entries(CANVAS_PLACEMENTS).filter(([, message]) => message === type).map(([placement]) => placement);
    return {
      application_type: "web",
      response_types: ["id_token"],
      grant_types: ["implicit", "client_credentials"],
      initiate_login_uri: endpoints.login,
      redirect_uris: [endpoints.launch],
      client_name: this.#options.toolName,
      jwks_uri: endpoints.jwks,
      token_endpoint_auth_method: "private_key_jwt",
      scope: scopes.join(" "),
      "https://purl.imsglobal.org/spec/lti-tool-configuration": {
        domain: new URL(endpoints.launch).host,
        target_link_uri: endpoints.launch,
        claims: ["iss", "sub"],
        messages: [
          { type: "LtiResourceLinkRequest", target_link_uri: endpoints.launch, placements: placementsOf("LtiResourceLinkRequest") },
          { type: "LtiDeepLinkingRequest", target_link_uri: endpoints.launch, placements: placementsOf("LtiDeepLinkingRequest") },
        ],
        "https://canvas.instructure.com/lti/privacy_level": "anonymous",
      },
    };
  }

  /** Fetches JSON from the platform without following redirects, refusing a large or failed answer. */
  async #fetchJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#options.fetch(url, { ...init, redirect: "manual" });
    } catch {
      throw new EducateOsError("unavailable", "The platform could not be reached.");
    }
    // The platform's body is never repeated: it may echo the registration token.
    if (!response.ok) throw new EducateOsError("unavailable", `The platform refused the registration request (${response.status}).`);
    try {
      return await readJson(response);
    } catch {
      throw new EducateOsError("validation-failed", "The platform's answer is not readable JSON.");
    }
  }
}

function completionPage(): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>Registration received</title></head><body><main>',
    "<h1>Registration received</h1>",
    "<p>A district administrator must approve this connection before any course can use it.</p>",
    `<script>${REGISTRATION_CLOSE_SCRIPT}</script>`,
    "</main></body></html>",
  ].join("");
}
