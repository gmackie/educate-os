// The login and launch steps are extracted from PlayTrek `packages/lti/src/oidc/login.ts` and
// `packages/lti/src/oidc/callback.ts` at commit 7258e4347. PlayTrek handed both to `@gmacko/lti`
// with a stateless, HMAC-signed state; here the state and nonce are server-side and single-use,
// the deployment and target link are checked, and the launch resolves to a district principal.
import { errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { ActivityId, OfferingId, SchoolOsError } from "@schoolos/contracts";
import { ResolvedPrincipal, type PrincipalResolver } from "@schoolos/identity";
import { LaunchMessageType, parseLaunchClaims, type DeepLinkingSettings, type ParsedLaunchClaims } from "./claims.ts";
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
  type RegistrationKey,
} from "./registration.ts";
import { randomToken, type Clock, type SingleUseStore } from "./stores.ts";
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
});
/** A resolved launch. */
export type ResolvedLaunch = z.infer<typeof ResolvedLaunch>;

/**
 * The OIDC third-party login initiation parameters. A stripping `z.object`: platforms add their
 * own (Canvas sends `canvas_region` and `lti_storage_target`), and refusing them would refuse
 * Canvas.
 */
export const LoginInitiation = z.object({
  iss: z.string().min(1),
  login_hint: z.string().min(1),
  target_link_uri: z.string().min(1),
  lti_message_hint: z.string().optional(),
  lti_deployment_id: z.string().optional(),
  client_id: z.string().optional(),
});
/** Login initiation parameters. */
export type LoginInitiation = z.infer<typeof LoginInitiation>;

/** What the broker remembers between login initiation and launch. Single use. */
export interface LoginState {
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  readonly targetLinkUri: string;
  /** The deployment the login named, if it named one; the launch must then match it. */
  readonly deploymentId: string | undefined;
}

/** What the broker remembers between a deep linking request and the principal's choice. Single use. */
export interface DeepLinkSession {
  readonly registration: RegistrationKey;
  readonly deploymentId: string;
  readonly settings: DeepLinkingSettings;
  readonly launch: ResolvedLaunch;
}

/** The tool's own endpoints, all under one HTTPS origin. */
export interface LtiToolEndpoints {
  readonly login: string;
  readonly launch: string;
  readonly jwks: string;
  readonly deepLink: string;
}

/** The endpoints for a tool served at `origin` (for example `https://northfield.schoolos.example`). */
export function ltiToolEndpoints(origin: string): LtiToolEndpoints {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.origin !== origin) {
    throw new SchoolOsError("validation-failed", "The LTI tool origin must be a bare https origin.");
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

/** The result of starting a login: where to send the browser, and the state to bind to it. */
export interface LoginRedirect {
  readonly redirectUrl: string;
  readonly state: string;
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
  throw new SchoolOsError("unauthenticated", message);
};

/**
 * The SchoolOS LTI 1.3 broker. Every refusal is a {@link SchoolOsError}: `unauthenticated` for
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
    await this.#options.loginStates.put(
      state,
      {
        issuer: registration.issuer,
        clientId: registration.clientId,
        nonce,
        targetLinkUri: params.target_link_uri,
        deploymentId: params.lti_deployment_id,
      },
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
    return { redirectUrl: redirect.toString(), state };
  }

  /**
   * Validates a launch and resolves it. The login state is consumed first, so a replayed
   * `(id_token, state)` fails however the rest of validation would have gone, and a token replayed
   * with a fresh state fails on its nonce.
   */
  async launch(idToken: string, state: string): Promise<LaunchResult> {
    const login = await this.#options.loginStates.take(state);
    if (login === undefined) return refuse("The LTI launch state is unknown, expired or already used.");
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
      throw new SchoolOsError("forbidden", "This course is not connected to a SchoolOS offering.");
    }

    const resolver = await this.#options.principalResolver(registration.districtId);
    if (resolver === undefined || resolver.districtId !== registration.districtId) {
      throw new SchoolOsError("unavailable", "The district for this LTI registration is not available.");
    }
    // The issuer is the registration's, which the signature check bound the token to. Nothing but
    // `sub` is taken from the token, so name, email and role claims cannot select anyone.
    const principal = await resolver.resolve({ issuer: registration.issuer, subject: claims.subject, credential: "person" });

    const activity = this.#activity(registration, offeringId, claims);
    const launch: ResolvedLaunch = {
      principal,
      offeringId,
      ...(activity === undefined ? {} : { activity }),
      messageType: claims.messageType,
    };
    if (claims.messageType !== "LtiDeepLinkingRequest" || claims.deepLinking === undefined) {
      return { launch, deepLinkSession: undefined };
    }
    const session = randomToken();
    await this.#options.deepLinkSessions.put(
      session,
      { registration: { issuer: registration.issuer, clientId: registration.clientId }, deploymentId: claims.deploymentId, settings: claims.deepLinking, launch },
      this.#now() + DEEP_LINK_SESSION_TTL_MS,
    );
    return { launch, deepLinkSession: session };
  }

  /**
   * Answers a deep linking request. Consumes the session, asks `select` which activities the
   * session's principal placed (it must authorize them for the session's offering, and throw a
   * `SchoolOsError` to refuse), records an activity link for each in that offering, and returns the
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
      throw new SchoolOsError("validation-failed", "The platform does not accept activity links here.");
    }
    if (selections.length > 1 && settings.accept_multiple !== true) {
      throw new SchoolOsError("validation-failed", "The platform accepts only one item here.");
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
      if (err instanceof SchoolOsError) throw err;
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
    return claims.schoolosLinkId === undefined ? undefined : activityForLink(registration, offeringId, claims.schoolosLinkId);
  }
}
