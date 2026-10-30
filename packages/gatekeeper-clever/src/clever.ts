// The Clever gatekeeper Worker: the sign-in flow, the vendor and account entrypoints, the account
// Durable Object and the observer verifier. The bindings themselves are in clever-gatekeeper.ts.
//
// Credential model. A user connects by signing in with Clever (OAuth 2.0 authorization code, with
// PKCE). That sign-in only proves who they are: the account keeps their Clever user ID and district
// ID, and drops the tokens the sign-in returned, which are never used for data. Every data read and
// LMS Connect write is made with the district's own district-app token, which the deployment holds
// in `CLEVER_DISTRICT_TOKENS` and agents never see, and each is scoped to what that user may reach
// (clever-access.ts).

import { DurableObject, RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  advanceToOAuth, claimOAuth, isConnectAttempted, markConnectAttempted, putInitiation,
} from "@gadgets/gatekeeper-kit/connect-handshake";
import { generateNonce, CONNECT_TIMEOUT_MS } from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  INVALID_LINK_HTML, connectHandoffPageHtml, errorPageHtml, escapeHtml, htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, discardStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { OAuthClient, createPkce } from "@gadgets/gatekeeper-kit/oauth-client";
import { PreviewOAuth, PreviewOAuthConfigurationError, type PreviewOAuthState } from "@gadgets/gatekeeper-kit/preview-oauth";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { createLogger } from "@gadgets/observability/logger";
import {
  workerVersionTag,
  type AccountDescription, type ConnectHandoff, type Gatekeeper, type GatekeeperConnectCallback,
  type GatekeeperConnectOptions, type GatekeeperUser, type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface, type ResourceConfiguratorFrame, type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CleverAccess, districtApi, type CleverIdentity } from "./clever-access";
import { CleverNoticeUI, CleverSectionPickerUI } from "./clever-configurators";
import {
  CLEVER_ID, DISTRICT_PATTERN, PROFILE_PATTERN, RESOURCE_BY_KIND, SECTION_PATTERN, STUDENT_PATTERN,
  STUDENT_SECTION_PATTERN, SUPPORTED_RESOURCES, TEACHER_PATTERN, VENDOR_ID, apiBase, districtToken, getBasePath,
  getBaseUrl, getOAuthCallbackUri, oauthBase, parseResourceUrl, type Env,
} from "./clever-env";
import type { CleverGatekeeperProps } from "./clever-gatekeeper";
import { nameOf } from "./clever-model";
import type { CleverVerifierApi } from "./clever-verifier-types";
import CLEVER_LOGO_SVG from "./clever-logo.svg";
import TYPES_CODE from "./types.txt";
import DISTRICT_CONFIGURATOR_HTML from "./generated/clever-district-configurator-ui.txt";
import PROFILE_CONFIGURATOR_HTML from "./generated/clever-profile-configurator-ui.txt";
import STUDENT_CONFIGURATOR_HTML from "./generated/clever-student-configurator-ui.txt";
import TEACHER_CONFIGURATOR_HTML from "./generated/clever-teacher-configurator-ui.txt";

export { CleverGatekeeperImpl } from "./clever-gatekeeper";
export { CleverDistrictLedger } from "./clever-ledger";

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.clever", vendorId: VENDOR_ID });

const LOGO_URL = `data:image/svg+xml,${encodeURIComponent(CLEVER_LOGO_SVG)}`;
const HEX_64 = /^[0-9a-f]{64}$/;
const USERINFO_TIMEOUT_MS = 20_000;

const NOT_CONFIGURED_HTML = errorPageHtml(
  "Clever is not configured",
  "This deployment has no Clever app yet. Ask its administrator to add the Clever client ID and secret.");

/** What a connect attempt carries from its link to the OAuth callback. */
type ConnectAttempt = {
  /** Set only by `connectAccount`; anything else is a reconnect. */
  firstConnect?: true;
  codeVerifier?: string;
  redirectUri?: string;
};

function loginHintForm(action: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in with Clever</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.4rem">Sign in with Clever</h1>
<p>This is a demo district. Enter the email or Clever user ID of the synthetic person to sign in as.</p>
<form method="get" action="${escapeHtml(action)}">
<input name="login_hint" required style="width:100%;padding:.5rem" autocomplete="off">
<button type="submit" style="margin-top:1rem;padding:.5rem 1rem">Continue</button>
</form></body></html>`;
}

function oauthClient(env: Env): OAuthClient {
  return new OAuthClient({
    label: "Clever",
    client: { method: "basic", id: env.CLIENT_ID!, secret: env.CLIENT_SECRET! },
    authorizationEndpoint: `${oauthBase(env)}/oauth/authorize`,
    tokenEndpoint: `${oauthBase(env)}/oauth/tokens`,
  });
}

/** Main HTTP entrypoint: the sign-in flow. */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      return new Response("Not Found", { status: 404 });
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (req.method === "GET" && path.length === 2 && HEX_64.test(path[0]!) && HEX_64.test(path[1]!)) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) return htmlResponse(NOT_CONFIGURED_HTML, 503);
      const hint = url.searchParams.get("login_hint")?.trim() || undefined;
      if (env.CLEVER_LOGIN_HINT_FORM === "true" && hint === undefined) {
        return htmlResponse(loginHintForm(url.pathname));
      }
      let previewOAuth: PreviewOAuth;
      try {
        previewOAuth = new PreviewOAuth({ callbackUri: getOAuthCallbackUri(env), env });
      } catch (error) {
        return new Response(error instanceof Error ? error.message : "Clever sign-in is not configured.", { status: 503 });
      }
      let account;
      try {
        account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(path[0]!));
      } catch {
        return htmlResponse(INVALID_LINK_HTML, 400);
      }
      const begun = await account.beginOAuthFlow(path[1]!, previewOAuth.redirectUri);
      if (begun === null) return htmlResponse(INVALID_LINK_HTML, 400);
      const state = await previewOAuth.createAuthorizationState({ userObjectId: path[0]!, oauthNonce: begun.oauthNonce });
      const authorize = oauthClient(env).authorizationUrl({
        redirectUri: previewOAuth.redirectUri,
        state,
        scopes: ["openid"],
        codeChallenge: begun.codeChallenge,
        ...(hint === undefined || env.CLEVER_LOGIN_HINT_FORM !== "true" ? {} : { params: { login_hint: hint } }),
      });
      return Response.redirect(authorize.toString(), 302);
    }

    if (req.method === "GET" && relPath === "/oauth") {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) return htmlResponse(NOT_CONFIGURED_HTML, 503);
      if (!url.searchParams.get("state")) return new Response("Error: no 'state' provided", { status: 400 });
      let state: PreviewOAuthState;
      try {
        const result = await new PreviewOAuth({ callbackUri: getOAuthCallbackUri(env), env }).handleCallback(url);
        if (result.kind === "relay") return result.response;
        state = result.state;
      } catch (error) {
        const status = error instanceof PreviewOAuthConfigurationError ? 500 : 400;
        return new Response(error instanceof Error ? error.message : "Invalid Clever sign-in state", { status });
      }
      const account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(state.userObjectId));
      if (url.searchParams.get("error")) {
        if (!await account.consumeOAuthNonce(state.oauthNonce)) return htmlResponse(INVALID_LINK_HTML, 400);
        return htmlResponse(errorPageHtml("Clever sign-in was not completed", "Start the connection again."), 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided", { status: 400 });
      const outcome = await account.acceptAuthCode(code, state.oauthNonce);
      if (outcome === null) return htmlResponse(INVALID_LINK_HTML, 400);
      if ("refused" in outcome) return htmlResponse(errorPageHtml(outcome.refused.title, outcome.refused.detail), 400);
      return htmlResponse(connectHandoffPageHtml(outcome.handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------------------------

/** Top-level API exposed to the Workshop. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Clever",
      url: "https://clever.com",
      logo: { url: LOGO_URL },
      color: "#f1f3f5",
      tagline: "Read class rosters, post assignments and record grades through your district's Clever",
      description:
        "Sign in with Clever to give agents your district's class records as you may see them: the " +
        "sections you teach or are enrolled in, their rosters by name and grade level, and the " +
        "assignments and grades in each section's learning management system. Every change waits for " +
        "your approval.",
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // No type is separately grantable: one sign-in serves every type, so the options change nothing.
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------------------------

/** What the Clever sign-in proved, read from Clever's userinfo. */
function identityFromUserinfo(body: unknown): CleverIdentity | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = body as Record<string, unknown>;
  // In API v3.x a user's ID is the multi-role ID, which is also the OIDC subject.
  const userId = [raw.multi_role_user_id, raw.sub].find(value => typeof value === "string" && CLEVER_ID.test(value));
  const districtId = [raw.district_id, raw.district].find(value => typeof value === "string" && CLEVER_ID.test(value));
  return typeof userId === "string" && typeof districtId === "string" ? { userId, districtId } : undefined;
}

type AcceptOutcome = { handoff: ConnectHandoff } | { refused: { title: string; detail: string } };

const IDENTITY_KEY = "identity";

/** One connected Clever user: who they signed in as, and the Workshop's callback. */
export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (this.ctx.storage.kv.get(IDENTITY_KEY) === undefined) {
      // Self-destruct if the connect flow is never completed.
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    putInitiation<ConnectAttempt>(this.ctx.storage.kv, initiationNonce, Date.now(), { firstConnect: true });
  }

  /** Mints a reconnect link's nonce. Recorded without `firstConnect`, so it stages its result. */
  async prepareReconnect(initiationNonce: string): Promise<void> {
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  /** Advances a live connect link to Clever, or null when the link is invalid or used. */
  async beginOAuthFlow(initiationNonce: string, redirectUri: string): Promise<{ oauthNonce: string; codeChallenge: string } | null> {
    const pkce = await createPkce();
    const oauthNonce = advanceToOAuth<ConnectAttempt>(this.ctx.storage.kv, initiationNonce, Date.now(), {
      codeVerifier: pkce.codeVerifier, redirectUri,
    });
    return oauthNonce === null ? null : { oauthNonce, codeChallenge: pkce.codeChallenge };
  }

  consumeOAuthNonce(oauthNonce: string): boolean {
    return claimOAuth(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }

  /**
   * Finishes the sign-in: redeems the code, learns who signed in, confirms them against the
   * district's records, and returns the handoff for the page the browser lands on. Null when the
   * OAuth nonce is invalid or used.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<AcceptOutcome | null> {
    const claim = claimOAuth<ConnectAttempt>(this.ctx.storage.kv, oauthNonce, Date.now());
    if (claim === null || claim.redirectUri === undefined) return null;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Took too long to complete the sign-in. Please try again.");

    const tokens = await oauthClient(this.env).exchangeCode({
      code, redirectUri: claim.redirectUri, ...(claim.codeVerifier === undefined ? {} : { codeVerifier: claim.codeVerifier }),
    });
    // The sign-in's tokens prove who signed in, here, and are then dropped: they are never stored.
    const identity = await this.#userinfo(tokens.accessToken);
    if (identity === undefined) {
      return { refused: { title: "Clever did not say who signed in", detail: "Try signing in again." } };
    }
    if (districtToken(this.env, identity.districtId) === undefined) {
      return {
        refused: {
          title: "Your district is not connected",
          detail: "This deployment has no Clever connection for your district. Ask its administrator to add it.",
        },
      };
    }
    const user = await districtApi(this.env, identity.districtId).user(identity.userId).catch(() => undefined);
    if (user === undefined || user.district !== identity.districtId) {
      return { refused: { title: "You are not in your district's records", detail: "Ask your district to share your Clever account." } };
    }

    if (claim.firstConnect !== true) {
      // A reconnect link is a bearer capability, so the identity is only staged until the Workshop
      // confirms the browser that finished is the owner's (commitReconnect).
      const current = this.ctx.storage.kv.get<CleverIdentity>(IDENTITY_KEY);
      if (current !== undefined && (current.userId !== identity.userId || current.districtId !== identity.districtId)) {
        return {
          refused: {
            title: "That's a different Clever account",
            detail: "This connection is for another Clever user. Sign in as them, or connect a new account.",
          },
        };
      }
      discardStagedCredentials(this.ctx.storage.kv);
      const stageId = stageCredentials(this.ctx.storage.kv, identity, Date.now());
      return { handoff: await callback.reconnectComplete(stageId) };
    }

    if (isConnectAttempted(this.ctx.storage.kv)) {
      return { refused: { title: "This connection is already complete", detail: "Start a new connection." } };
    }
    this.ctx.storage.kv.put(IDENTITY_KEY, identity);
    markConnectAttempted(this.ctx.storage.kv);
    let handoff: ConnectHandoff;
    try {
      const props = { userObjectId: this.ctx.id.toString() };
      handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
    } catch (error) {
      // Nothing outside this account holds the identity, so a failed handoff leaves no connection.
      this.ctx.storage.kv.delete(IDENTITY_KEY);
      throw error;
    }
    await this.ctx.storage.deleteAlarm();
    return { handoff };
  }

  async #userinfo(accessToken: string): Promise<CleverIdentity | undefined> {
    const fetch = globalThis.fetch;
    const response = await fetch(`${apiBase(this.env)}/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      logger.warn("Clever refused the userinfo request", { event: "clever.userinfo.refused", vendorId: VENDOR_ID });
      return undefined;
    }
    try {
      return identityFromUserinfo(JSON.parse(await readTextCapped(response, 64 * 1024)));
    } catch {
      return undefined;
    }
  }

  /** Makes the identity staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    const staged = commitStagedCredentials<CleverIdentity>(this.ctx.storage.kv, Date.now(), stageId);
    if (staged === null) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.ctx.storage.kv.put(IDENTITY_KEY, staged);
    await this.ctx.storage.deleteAlarm();
  }

  /** Who the account signed in as. Throws once it is disconnected. */
  getIdentity(): CleverIdentity {
    const identity = this.ctx.storage.kv.get<CleverIdentity>(IDENTITY_KEY);
    if (identity === undefined) throw new Error("This Clever connection has been removed. Reconnect your Clever account.");
    return identity;
  }

  async alarm(): Promise<void> {
    if (this.ctx.storage.kv.get(IDENTITY_KEY) === undefined) await this.ctx.storage.deleteAll();
  }

  /** Disconnects. There is nothing to revoke at Clever: the sign-in's tokens were never kept. */
  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------------------------

type UserImplProps = { userObjectId: string };

const CONFIGURATOR_BY_PATTERN: Record<string, { html: string; ui: "teacher" | "student" | "notice" }> = {
  [TEACHER_PATTERN]: { html: TEACHER_CONFIGURATOR_HTML, ui: "teacher" },
  [SECTION_PATTERN]: { html: TEACHER_CONFIGURATOR_HTML, ui: "teacher" },
  [STUDENT_PATTERN]: { html: STUDENT_CONFIGURATOR_HTML, ui: "student" },
  [STUDENT_SECTION_PATTERN]: { html: STUDENT_CONFIGURATOR_HTML, ui: "student" },
  [PROFILE_PATTERN]: { html: PROFILE_CONFIGURATOR_HTML, ui: "notice" },
  [DISTRICT_PATTERN]: { html: DISTRICT_CONFIGURATOR_HTML, ui: "notice" },
};

/** A connected Clever user, as the Workshop holds it. */
@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, UserImplProps> implements GatekeeperUser {
  #account() {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #access(): CleverAccess {
    return new CleverAccess(this.env, () => this.#account().getIdentity());
  }

  async describe(): Promise<AccountDescription> {
    const { context, user } = await this.#access().self();
    return { displayName: nameOf(user), uniqueName: context.identity.userId, avatar: { url: LOGO_URL } };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Not a sign-in provider: a Clever email is not verified by Clever.
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<unknown>>; resource: SupportedResource }> {
    const target = parseResourceUrl(url);
    const props: CleverGatekeeperProps = { userObjectId: this.ctx.props.userObjectId, target };
    return { class: this.ctx.exports.CleverGatekeeperImpl({ props }), resource: RESOURCE_BY_KIND[target.kind] };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const configurator = CONFIGURATOR_BY_PATTERN[resourceUrlPattern];
    if (configurator === undefined) throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    const access = this.#access();
    const ui = configurator.ui === "notice" ? new CleverNoticeUI(access) : new CleverSectionPickerUI(access, configurator.ui);
    return { iframeHtml: configurator.html, ui: new RpcStub(ui) };
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    // No type is separately grantable: the sign-in already covers every one.
    return {};
  }

  /** A verifier for this user, which the Clever gatekeepers' addObserver consults. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CleverVerifier({ props: { userObjectId: this.ctx.props.userObjectId } });
  }
}

/**
 * Answers, for an observer, what the district's records say they teach. Their identity comes from
 * their own connected account; the records are read with their district's token.
 */
export class CleverVerifier extends WorkerEntrypoint<Env, UserImplProps> implements CleverVerifierApi {
  async teachesSections(sectionIds: string[]): Promise<boolean[]> {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    const access = new CleverAccess(this.env, () => account.getIdentity());
    return Promise.all(sectionIds.map(async sectionId => {
      if (typeof sectionId !== "string" || !CLEVER_ID.test(sectionId)) return false;
      try {
        await access.section("teacher", sectionId);
        return true;
      } catch (error) {
        // Not on the roster, or no such section: they cannot see it. Anything else fails the open
        // loudly rather than silently denying.
        if ((error as { code?: unknown }).code === "not-found") return false;
        throw error;
      }
    }));
  }
}
