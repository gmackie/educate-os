// The login and launch steps are extracted from PlayTrek `packages/lti/src/oidc/login.ts` and
// `packages/lti/src/oidc/callback.ts` at commit 7258e4347. PlayTrek handed both to `@gmacko/lti`
// with a stateless, HMAC-signed state; here the state and nonce are server-side and single-use,
// the deployment and target link are checked, and the launch resolves to a district principal.
import { decodeJwt, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { ActivityId, OfferingId, EducateOsError } from "@educateos/contracts";
import { ResolvedPrincipal, type PrincipalResolver } from "@educateos/identity";
import { DeepLinkingSettings, LaunchMessageType, parseLaunchClaims, type ParsedLaunchClaims } from "./claims.ts";
import {
  activityContentItem,
  deepLinkingReturnPage,
  signDeepLinkingResponse,
  type DeepLinkSelection,
} from "./deep-linking.ts";
import type { PlatformJwksCache } from "./platform-jwks.ts";
import {
  activityForLink,
  offeringForContext,
  type PlatformRegistration,
  type PlatformRegistrationStore,
} from "./registration.ts";
import { LtiContextServices } from "./service-client.ts";
import { platformStorageKey, StorageTarget, type PlatformStorageRequest } from "./platform-storage.ts";
import { randomToken, sha256Base64Url, type Clock, type SingleUseStore } from "./stores.ts";
import { toolJwks, type ToolKeySet, type ToolPublicJwk } from "./tool-keys.ts";

/** Clock skew tolerated on `exp`, `iat` and `nbf`, in seconds. */
export const CLOCK_SKEW_SECONDS = 60;
/** The oldest `iat` a launch may carry, in seconds. A launch is posted seconds after it is minted. */
export const MAX_LAUNCH_AGE_SECONDS = 10 * 60;
/** How long a login state (and its nonce) stays usable, in milliseconds. */
export const LOGIN_STATE_TTL_MS = 10 * 60_000;
/** How long a principal has to choose content after a deep linking request, in milliseconds. */
export const DEEP_LINK_SESSION_TTL_MS = 30 * 60_000;

/**
 * A launch the broker accepted: who it is, which offering it is in, and the activity it opens if
 * the link is mapped to one. This is authentication and context only. Whether the principal may do
 * anything in the offering is decided by policy from directory roles; the platform's role claims
 * were never read.
 */
export const ResolvedLaunch = z.strictObject({
  principal: ResolvedPrincipal,
  offeringId: OfferingId,
  activity: ActivityId.optional(),
  messageType: LaunchMessageType,
  /**
   * The LTI Advantage services (AGS, NRPS) the platform offers in the launch's context, when it
   * offers any. The host records them for the offering; nothing is called during the launch.
   */
  services: LtiContextServices.optional(),
});
/** A resolved launch. */
export type ResolvedLaunch = z.infer<typeof ResolvedLaunch>;

/**
 * The OIDC third-party login initiation parameters. A stripping `z.object`: platforms add their
 * own (Canvas sends `canvas_region`), and refusing them would refuse Canvas. `lti_storage_target`
 * names the platform frame that offers client-side storage when cookies may be blocked.
 */
export const LoginInitiation = z.object({
  iss: z.string().min(1),
  login_hint: z.string().min(1),
  target_link_uri: z.string().min(1),
  lti_message_hint: z.string().optional(),
  lti_deployment_id: z.string().optional(),
  client_id: z.string().optional(),
  lti_storage_target: StorageTarget.optional(),
});
/** Login initiation parameters. */
export type LoginInitiation = z.infer<typeof LoginInitiation>;

const LtiId = z.string().min(1).max(255);
const RegistrationKeyShape = z.strictObject({ issuer: z.url({ protocol: /^https$/ }), clientId: LtiId });

/**
 * What the broker remembers between login initiation and launch. Single use.
 *
 * `storageDigest` is present when the platform offered client-side storage: the login put a fresh
 * secret there, and only its SHA-256 is kept here. A launch that arrives without the state cookie
 * must return that secret, read back from the same browser's platform storage.
 */
export const LoginState = z.strictObject({
  issuer: RegistrationKeyShape.shape.issuer,
  clientId: LtiId,
  nonce: z.string().min(1),
  targetLinkUri: z.string().min(1),
  /** The deployment the login named, if it named one; the launch must then match it. */
  deploymentId: LtiId.optional(),
  storageDigest: z.string().min(1).optional(),
});
/** A login state. */
export type LoginState = z.infer<typeof LoginState>;

/** What the broker remembers between a deep linking request and the principal's choice. Single use. */
export const DeepLinkSession = z.strictObject({
  registration: RegistrationKeyShape,
  deploymentId: LtiId,
  settings: DeepLinkingSettings,
  launch: ResolvedLaunch,
});
/** A deep linking session. */
export type DeepLinkSession = z.infer<typeof DeepLinkSession>;

/**
 * How a launch proves it is posted by the browser that started its login. Either the browser sent
 * the `__Host-lti-state-<state>` cookie, which only that browser holds, or it read the login's
 * secret back from the platform's client-side storage, which is keyed to this tool's origin in that
 * browser. Without one of these, an attacker could post their own id_token from a victim's browser.
 */
export type LaunchBinding =
  | { readonly kind: "state-cookie" }
  | { readonly kind: "platform-storage"; readonly value: string };

/** The launch binding for a request that carried the login's state cookie. */
export const STATE_COOKIE_BINDING: LaunchBinding = { kind: "state-cookie" };

/** The tool's own endpoints, all under one HTTPS origin. */
export interface LtiToolEndpoints {
  readonly login: string;
  readonly launch: string;
  readonly jwks: string;
  readonly deepLink: string;
}

/** The endpoints for a tool served at `origin` (for example `https://northfield.educateos.example`). */
export function ltiToolEndpoints(origin: string): LtiToolEndpoints {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.origin !== origin) {
    throw new EducateOsError("validation-failed", "The LTI tool origin must be a bare https origin.");
  }
  return {
    login: `${origin}/lti/login`,
    launch: `${origin}/lti/launch`,
    jwks: `${origin}/lti/jwks`,
    deepLink: `${origin}/lti/deep-link`,
  };
}

/** Everything the broker depends on. */
export interface LtiBrokerOptions {
  /** The tool's HTTPS origin. */
  readonly toolOrigin: string;
  readonly registrations: PlatformRegistrationStore;
  readonly loginStates: SingleUseStore<LoginState>;
  readonly deepLinkSessions: SingleUseStore<DeepLinkSession>;
  readonly platformKeys: PlatformJwksCache;
  /** The tool's current keys. Read on every use, so a rotation takes effect immediately. */
  readonly toolKeys: () => ToolKeySet;
  /** The principal resolver for a district, or `undefined` if this deployment does not serve it. */
  readonly principalResolver: (districtId: PlatformRegistration["districtId"]) => Promise<PrincipalResolver | undefined>;
  readonly now?: Clock;
}

/**
 * The result of starting a login: where to send the browser, and the state to bind to it. When the
 * platform offered client-side storage, `storage` is what the browser must put there before it
 * follows the redirect.
 */
export interface LoginRedirect {
  readonly redirectUrl: string;
  readonly state: string;
  readonly storage: PlatformStorageRequest | undefined;
}

/** The result of a launch. A deep linking request also gets a session for the content picker. */
export interface LaunchResult {
  readonly launch: ResolvedLaunch;
  readonly deepLinkSession: string | undefined;
}

/** A signed deep linking response, and the page that posts it to the platform. */
export interface DeepLinkingReturn {
  readonly returnUrl: string;
  readonly jwt: string;
  readonly html: string;
}

const refuse = (message: string): never => {
  throw new EducateOsError("unauthenticated", message);
};

/**
 * The EducateOS LTI 1.3 broker. Every refusal is a {@link EducateOsError}: `unauthenticated` for
 * anything wrong with the login, the token or the identity; `forbidden` for a launch from a course
 * the registration does not map; `unavailable` when a platform or district cannot be reached.
 */
export class LtiBroker {
  readonly endpoints: LtiToolEndpoints;
  readonly #options: LtiBrokerOptions;
  readonly #now: Clock;

  constructor(options: LtiBrokerOptions) {
    this.endpoints = ltiToolEndpoints(options.toolOrigin);
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Handles OIDC third-party login initiation. Refuses an issuer, client or deployment with no
   * registration, and a target link outside the tool. Stores a fresh state and nonce, single-use,
   * for {@link LOGIN_STATE_TTL_MS}.
   */
  async login(input: unknown): Promise<LoginRedirect> {
    const parsed = LoginInitiation.safeParse(input);
    if (!parsed.success) return refuse("The LTI login request is incomplete.");
    const params = parsed.data;
    const registration = await this.#registrationForLogin(params);
    if (params.lti_deployment_id !== undefined && !registration.deploymentIds.includes(params.lti_deployment_id)) {
      return refuse("This LTI deployment is not registered.");
    }
    if (!this.#isToolUrl(params.target_link_uri)) return refuse("The LTI target link is not part of this tool.");

    const state = randomToken();
    const nonce = randomToken();
    const storageSecret = params.lti_storage_target === undefined ? undefined : randomToken();
    await this.#options.loginStates.put(
      state,
      LoginState.parse({
        issuer: registration.issuer,
        clientId: registration.clientId,
        nonce,
        targetLinkUri: params.target_link_uri,
        ...(params.lti_deployment_id === undefined ? {} : { deploymentId: params.lti_deployment_id }),
        ...(storageSecret === undefined ? {} : { storageDigest: await sha256Base64Url(storageSecret) }),
      }),
      this.#now() + LOGIN_STATE_TTL_MS,
    );

    const redirect = new URL(registration.authLoginUrl);
    const query: Record<string, string | undefined> = {
      scope: "openid",
      response_type: "id_token",
      response_mode: "form_post",
      prompt: "none",
      client_id: registration.clientId,
      redirect_uri: this.endpoints.launch,
      login_hint: params.login_hint,
      lti_message_hint: params.lti_message_hint,
      state,
      nonce,
    };
    for (const [name, value] of Object.entries(query)) if (value !== undefined) redirect.searchParams.set(name, value);
    const storage =
      params.lti_storage_target === undefined || storageSecret === undefined
        ? undefined
        : {
            target: params.lti_storage_target,
            platformOrigin: new URL(registration.authLoginUrl).origin,
            key: platformStorageKey(state),
            value: storageSecret,
          };
    return { redirectUrl: redirect.toString(), state, storage };
  }

  /**
   * The platform origin a launch's storage read must be answered from, for a launch posted without
   * the state cookie. It is the origin of the registration's OIDC endpoint, which is where the
   * login put the secret. The token is only decoded here to find its registration; nothing in it is
   * trusted until {@link launch} verifies it, and that also checks it against the login's own
   * registration.
   */
  async platformStorageOrigin(idToken: string): Promise<string> {
    let claims: { iss?: unknown; aud?: unknown; azp?: unknown };
    try {
      claims = decodeJwt(idToken);
    } catch {
      return refuse("The LTI launch token is invalid.");
    }
    const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    const clientId = typeof claims.azp === "string" ? claims.azp : audiences.length === 1 ? audiences[0] : undefined;
    if (typeof claims.iss !== "string" || typeof clientId !== "string") return refuse("The LTI launch token is invalid.");
    const registration = await this.#options.registrations.get({ issuer: claims.iss, clientId });
    if (registration === undefined) return refuse("This LTI platform is not registered.");
    return new URL(registration.authLoginUrl).origin;
  }

  /**
   * Validates a launch and resolves it. The login state is consumed first, so a replayed
   * `(id_token, state)` fails however the rest of validation would have gone, and a token replayed
   * with a fresh state fails on its nonce. `binding` is how the request proved it came from the
   * browser that started the login (see {@link LaunchBinding}); the caller checks the cookie, and
   * the broker checks a platform-storage secret against the login's digest.
   */
  async launch(idToken: string, state: string, binding: LaunchBinding): Promise<LaunchResult> {
    const login = await this.#options.loginStates.take(state);
    if (login === undefined) return refuse("The LTI launch state is unknown, expired or already used.");
    if (binding.kind === "platform-storage") {
      if (login.storageDigest === undefined || !constantTimeEqual(await sha256Base64Url(binding.value), login.storageDigest)) {
        return refuse("This LTI launch did not start in this browser.");
      }
    }
    const registration = await this.#options.registrations.get(login);
    if (registration === undefined) return refuse("This LTI platform is not registered.");

    const claims = await this.#verify(idToken, registration);
    if (claims.nonce !== login.nonce) return refuse("The LTI launch nonce does not match.");
    if (!registration.deploymentIds.includes(claims.deploymentId)) return refuse("This LTI deployment is not registered.");
    if (login.deploymentId !== undefined && claims.deploymentId !== login.deploymentId) {
      return refuse("The LTI launch came through a different deployment than its login.");
    }
    if (claims.targetLinkUri !== login.targetLinkUri) return refuse("The LTI launch target does not match its login.");

    const offeringId = claims.contextId === undefined ? undefined : offeringForContext(registration, claims.contextId);
    if (offeringId === undefined) {
      throw new EducateOsError("forbidden", "This course is not connected to a EducateOS offering.");
    }

    const resolver = await this.#options.principalResolver(registration.districtId);
    if (resolver === undefined || resolver.districtId !== registration.districtId) {
      throw new EducateOsError("unavailable", "The district for this LTI registration is not available.");
    }
    // The issuer is the registration's, which the signature check bound the token to. Nothing but
    // `sub` is taken from the token, so name, email and role claims cannot select anyone.
    const principal = await resolver.resolve({ issuer: registration.issuer, subject: claims.subject, credential: "person" });

    const activity = this.#activity(registration, offeringId, claims);
    const services = contextServices(registration, claims);
    const launch: ResolvedLaunch = {
      principal,
      offeringId,
      ...(activity === undefined ? {} : { activity }),
      messageType: claims.messageType,
      ...(services === undefined ? {} : { services }),
    };
    if (claims.messageType !== "LtiDeepLinkingRequest" || claims.deepLinking === undefined) {
      return { launch, deepLinkSession: undefined };
    }
    const session = randomToken();
    await this.#options.deepLinkSessions.put(
      session,
      DeepLinkSession.parse({
        registration: { issuer: registration.issuer, clientId: registration.clientId },
        deploymentId: claims.deploymentId,
        settings: claims.deepLinking,
        launch,
      }),
      this.#now() + DEEP_LINK_SESSION_TTL_MS,
    );
    return { launch, deepLinkSession: session };
  }

  /**
   * Answers a deep linking request. Consumes the session, asks `select` which activities the
   * session's principal placed (it must authorize them for the session's offering, and throw a
   * `EducateOsError` to refuse), records an activity link for each in that offering, and returns the
   * signed response. An empty selection is a valid answer: the principal cancelled.
   */
  async completeDeepLink(
    session: string,
    select: (launch: ResolvedLaunch) => Promise<readonly DeepLinkSelection[]>,
  ): Promise<DeepLinkingReturn> {
    const deepLink = await this.#options.deepLinkSessions.take(session);
    if (deepLink === undefined) return refuse("The deep linking session is unknown, expired or already used.");
    const { settings } = deepLink;
    const selections = await select(deepLink.launch);
    if (selections.length > 0 && !settings.accept_types.includes("ltiResourceLink")) {
      throw new EducateOsError("validation-failed", "The platform does not accept activity links here.");
    }
    if (selections.length > 1 && settings.accept_multiple !== true) {
      throw new EducateOsError("validation-failed", "The platform accepts only one item here.");
    }

    const items = [];
    for (const selection of selections) {
      const linkId = `dl-${randomToken().slice(0, 24)}`;
      await this.#options.registrations.addActivityLink(deepLink.registration, {
        offeringId: deepLink.launch.offeringId,
        linkId,
        activityId: selection.activityId,
      });
      items.push(activityContentItem(selection, this.endpoints.launch, linkId));
    }
    const jwt = await signDeepLinkingResponse({
      clientId: deepLink.registration.clientId,
      platformIssuer: deepLink.registration.issuer,
      deploymentId: deepLink.deploymentId,
      items,
      data: settings.data,
      signingKey: this.#options.toolKeys().signing,
      issuedAt: Math.floor(this.#now() / 1000),
      nonce: randomToken(),
    });
    const returnUrl = settings.deep_link_return_url;
    return { returnUrl, jwt, html: deepLinkingReturnPage(returnUrl, jwt) };
  }

  /** The tool JWKS document. */
  jwks(): { keys: ToolPublicJwk[] } {
    return toolJwks(this.#options.toolKeys());
  }

  async #registrationForLogin(params: LoginInitiation): Promise<PlatformRegistration> {
    const { registrations } = this.#options;
    if (params.client_id !== undefined) {
      return (await registrations.get({ issuer: params.iss, clientId: params.client_id })) ?? refuse("This LTI platform is not registered.");
    }
    // `client_id` is optional in login initiation. Without it the issuer must be unambiguous.
    const candidates = await registrations.listByIssuer(params.iss);
    return candidates.length === 1 ? candidates[0]! : refuse("This LTI platform is not registered.");
  }

  #isToolUrl(value: string): boolean {
    try {
      return new URL(value).origin === new URL(this.endpoints.launch).origin;
    } catch {
      return false;
    }
  }

  async #verify(idToken: string, registration: PlatformRegistration): Promise<ParsedLaunchClaims> {
    const getKey: JWTVerifyGetKey = async (header) =>
      header.kid === undefined ? refuse("The LTI launch names no key.") : this.#options.platformKeys.getKey(registration.jwksUrl, header.kid);
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(idToken, getKey, {
        algorithms: ["RS256"],
        issuer: registration.issuer,
        audience: registration.clientId,
        clockTolerance: CLOCK_SKEW_SECONDS,
        maxTokenAge: MAX_LAUNCH_AGE_SECONDS,
        currentDate: new Date(this.#now()),
        requiredClaims: ["exp", "iat", "sub", "nonce"],
      }));
    } catch (err) {
      if (err instanceof EducateOsError) throw err;
      if (err instanceof joseErrors.JOSEError) return refuse("The LTI launch token is invalid.");
      throw err;
    }
    const claims = parseLaunchClaims(payload) ?? refuse("The LTI launch is not an acceptable LTI 1.3 message.");
    // With several audiences, `azp` must name this tool; when present it must name this tool anyway.
    if (claims.audience.length > 1 && claims.authorizedParty === undefined) return refuse("The LTI launch lacks azp.");
    if (claims.authorizedParty !== undefined && claims.authorizedParty !== registration.clientId) {
      return refuse("The LTI launch was issued to another client.");
    }
    return claims;
  }

  #activity(registration: PlatformRegistration, offeringId: OfferingId, claims: ParsedLaunchClaims): ActivityId | undefined {
    if (claims.messageType !== "LtiResourceLinkRequest") return undefined;
    const byResourceLink = claims.resourceLinkId === undefined ? undefined : activityForLink(registration, offeringId, claims.resourceLinkId);
    if (byResourceLink !== undefined) return byResourceLink;
    return claims.educateosLinkId === undefined ? undefined : activityForLink(registration, offeringId, claims.educateosLinkId);
  }
}

/** Compares two digests without an early exit, so timing reveals nothing about a near miss. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function contextServices(registration: PlatformRegistration, claims: ParsedLaunchClaims): LtiContextServices | undefined {
  const { ags, nrps } = claims.services;
  if (claims.contextId === undefined || (ags === undefined && nrps === undefined)) return undefined;
  return {
    registration: { issuer: registration.issuer, clientId: registration.clientId },
    contextId: claims.contextId,
    ...(ags === undefined ? {} : { ags: { ...ags, scopes: [...ags.scopes] } }),
    ...(nrps === undefined ? {} : { nrps }),
  };
}
