// EducateOS: a gatekeeper whose connected account gives a Workshop agent the district's school tools
// as a `SCHOOL` binding, acting as the district principal the account was verified as. README.md
// explains the design; the agent-facing session itself is session.ts.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  AppUiContext,
  ApprovalQueue,
  ConnectHandoff,
  Gatekeeper,
  GatekeeperAppNavEntry,
  GatekeeperConnectCallback,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperUiFrame,
  GitCache,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import { ActionApplyError, ActionJournal, defineActions, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import {
  CONNECT_TIMEOUT_MS, INITIATION_NONCE_LIFETIME_MS, constantTimeEqual, generateNonce, NONCE_BYTES,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  connectHandoffPageHtml, errorPageHtml, escapeHtml, htmlResponse, INVALID_LINK_HTML, PAGE_STYLE,
} from "@gadgets/gatekeeper-kit/connect-pages";
import type { VerifiedPrincipal } from "@educateos/contracts";
import { readSchoolNavFacts, schoolNav, type DistrictGet } from "./app-nav.ts";
import { describeChange, describeRead } from "./describe.ts";
import type { SchoolToolService } from "./district.ts";
import {
  decisionResult, SchoolToolsSessionCore, type SchoolChange, type SchoolToolCallResult, type SchoolToolInfo,
} from "./session.ts";
import type { DistrictResponse, SchoolAppApi } from "./school-app-api.ts";
import type { SchoolToolsSession } from "./types.js";
import TYPES_CODE from "./types.txt";
import APP_HTML from "./generated/app.txt";

const SCHOOL_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M251.76 88.94l-120-64a8 8 0 0 0-7.52 0l-120 64a8 8 0 0 0 0 14.12L32 117.87v48.42a15.91 15.91 0 0 0 4.06 10.65C49.16 191.53 78.51 216 128 216a130 130 0 0 0 48-8.76V240a8 8 0 0 0 16 0v-40.49a115.63 115.63 0 0 0 27.94-22.57 15.91 15.91 0 0 0 4.06-10.65v-48.42l27.76-14.81a8 8 0 0 0 0-14.12ZM128 200c-43.27 0-68.72-21.14-80-33.71V126.4l76.24 40.66a8 8 0 0 0 7.52 0L176 143.47v46.34C163.4 195.69 147.52 200 128 200Zm80-33.75a97.83 97.83 0 0 1-16 14.25v-45.57l16-8.53Zm-20.16-47.31a1.5 1.5 0 0 0-.32-.2l-56-29.87a8 8 0 0 0-7.52 14.12L171 128l-43 22.93L25 96l103-54.93L231 96Z'/></svg>",
    ),
};

/** The district's service, injected by the district deployment. Absent, nothing here works. */
function districtOf(env: Cloudflare.Env): SchoolToolService {
  if (env.EDUCATEOS_DISTRICT === undefined) {
    throw new Error("This deployment has no EducateOS district service bound to its school tools.");
  }
  return env.EDUCATEOS_DISTRICT;
}

/**
 * The origin requests to the district are addressed to. The district serves them by path, so with
 * no `DISTRICT_URL` a placeholder does; links that leave the app need the real one.
 */
function districtUrl(env: Cloudflare.Env): string {
  return env.DISTRICT_URL ?? "https://district.invalid";
}

function baseUrl(env: Cloudflare.Env): string {
  return (env.BASE_URL ?? "http://localhost:8787/gatekeeper/educateos").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Connect flow: the district's own sign-in decides which principal the account acts as.

type ConnectNonce = { value: string; expiresAt: number; connecting?: true };

type ConnectResult = { kind: "ok"; handoff: ConnectHandoff } | { kind: "invalid" } | { kind: "error"; message: string };

const ACCOUNT_ID_HEX = /^[0-9a-f]{64}$/;
const NONCE_HEX = new RegExp(`^[0-9a-f]{${NONCE_BYTES * 2}}$`);

/**
 * One connected account: the principal the district verified it as, and while it connects, the
 * Workshop's callback and the connect link's nonce.
 */
export class EducateOsAccountObject extends DurableObject<Cloudflare.Env> {
  /** Starts a connect flow. An account never completed deletes itself. */
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<ConnectNonce>("nonce", { value: nonce, expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS });
  }

  /** Whether `nonce` is this account's live, unclaimed connect nonce. */
  async isLiveNonce(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<ConnectNonce>("nonce");
    return stored !== undefined && !stored.connecting && Date.now() < stored.expiresAt && constantTimeEqual(stored.value, nonce);
  }

  /**
   * Binds the account to `principal`, which the district verified from the browser that followed
   * the connect link, and hands the account to the Workshop. The Workshop activates it only once
   * the handoff comes back over the initiating user's own session.
   */
  async completeConnection(nonce: string, principal: VerifiedPrincipal): Promise<ConnectResult> {
    if (!(await this.isLiveNonce(nonce))) return { kind: "invalid" };
    // Claimed before the first await, so a second submission cannot complete the flow again.
    const stored = this.ctx.storage.kv.get<ConnectNonce>("nonce")!;
    this.ctx.storage.kv.put<ConnectNonce>("nonce", { ...stored, connecting: true });
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback === undefined) return { kind: "error", message: "The connection expired. Start it again." };

    this.ctx.storage.kv.put<VerifiedPrincipal>("principal", { principalId: principal.principalId, districtId: principal.districtId });
    try {
      const handoff = await callback.complete(this.ctx.exports.EducateOsAccount({ props: { accountObjectId: this.ctx.id.toString() } }));
      this.ctx.storage.kv.delete("nonce");
      await this.ctx.storage.deleteAlarm();
      return { kind: "ok", handoff };
    } catch (error) {
      this.ctx.storage.kv.delete("principal");
      this.ctx.storage.kv.put<ConnectNonce>("nonce", stored);
      return { kind: "error", message: `The Workshop could not be told about the connection: ${String(error)}` };
    }
  }

  /** The principal this account acts as. Throws once the account is revoked or never connected. */
  async principal(): Promise<VerifiedPrincipal> {
    const principal = this.ctx.storage.kv.get<VerifiedPrincipal>("principal");
    if (principal === undefined) throw new Error("This EducateOS account is not connected.");
    return principal;
  }

  /** Forgets the account. */
  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    if (this.ctx.storage.kv.get("principal") === undefined) await this.ctx.storage.deleteAll();
  }
}

function confirmPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your school account</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>Connect your school account</h1>
<p class="sub">${escapeHtml("Your agent will use your school's tools with your access. Changes it asks to make wait for your approval.")}</p>
<form method="post"><button type="submit">Connect</button></form></main></body></html>`;
}

/** Serves the connect link: a confirmation page, then the district's verification on submit. */
async function handleConnect(request: Request, env: Cloudflare.Env, ctx: ExecutionContext, accountId: string, nonce: string): Promise<Response> {
  const namespace = ctx.exports.EducateOsAccountObject;
  const account = namespace.get(namespace.idFromString(accountId));
  if (request.method === "GET") {
    return htmlResponse(await account.isLiveNonce(nonce) ? confirmPageHtml() : INVALID_LINK_HTML);
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!(await account.isLiveNonce(nonce))) return htmlResponse(INVALID_LINK_HTML);

  // The district reads its own sign-in from this browser's request; nothing the page sends names anyone.
  const principal = await districtOf(env).authenticate(request);
  if (principal === null) {
    return htmlResponse(errorPageHtml("Sign in to your school account", "Sign in to your school in this browser, then open the link again."), 401);
  }
  const result = await account.completeConnection(nonce, principal);
  switch (result.kind) {
    case "ok": return htmlResponse(connectHandoffPageHtml(result.handoff));
    case "invalid": return htmlResponse(INVALID_LINK_HTML);
    case "error": return htmlResponse(errorPageHtml("Could not connect", result.message), 500);
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const base = new URL(baseUrl(env)).pathname;
    const path = new URL(request.url).pathname;
    if (!path.startsWith(`${base}/`)) return new Response("Not Found", { status: 404 });
    const [route, accountId, nonce, ...rest] = path.slice(base.length + 1).split("/");
    if (route === "connect" && rest.length === 0 && ACCOUNT_ID_HEX.test(accountId ?? "") && NONCE_HEX.test(nonce ?? "")) {
      return handleConnect(request, env, ctx, accountId!, nonce!);
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;

// ---------------------------------------------------------------------------
// The workspace facet: sessions, and the queued changes a person decides.

/** What apply and reject reach: the account's principal and the district. */
interface ChangeHost {
  decider(): Promise<VerifiedPrincipal>;
  district(): SchoolToolService;
}

const CHANGE_KIND: ActionKind = { tag: "school-change", label: "Change school records" };

// Never auto-approvable: a person decides every school change (SCHO-57).
const changes = defineActions<ChangeHost, { change: SchoolChange }>({
  change: {
    kind: CHANGE_KIND,
    delivery: "await-decision",
    // The district's own queue runs a change at most once, so a retried apply is harmless.
    describe: (change) => describeChange(change),
    apply: async (change, host) => {
      const result = decisionResult(await host.district().approveChange(await host.decider(), change.approvalId));
      if (result.kind === "refused") throw new ActionApplyError(result.message);
      if (result.kind === "retry") throw new Error(result.message);
    },
    reject: async (change, host) => {
      const result = decisionResult(await host.district().declineChange(await host.decider(), change.approvalId, "Declined in the Workshop."));
      // Refused means it is already decided or gone; only a failure that may pass is retried.
      if (result.kind === "retry") throw new Error(result.message);
    },
  },
}, { fence: "none" });

type FacetProps = { accountObjectId: string };

@validateRpc()
class SchoolToolsSessionImpl extends RpcTarget implements SchoolToolsSession {
  readonly #core: SchoolToolsSessionCore;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(core: SchoolToolsSessionCore, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#core = core;
    this.#queue = queue;
  }

  /** Lists the district's tools. */
  listTools(): Promise<SchoolToolInfo[]> {
    return this.#core.listTools();
  }

  /** Calls one tool as the account's principal. */
  callTool(name: string, args?: Record<string, unknown>): Promise<SchoolToolCallResult> {
    return this.#core.callTool(name, args);
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
}

@validateRpc()
export class EducateOsGatekeeper extends DurableObject<Cloudflare.Env, FacetProps> implements Gatekeeper<SchoolToolsSession> {
  readonly #journal = new ActionJournal<TaggedAction<{ change: SchoolChange }>>(this.ctx.storage.kv, { namespace: "school" });
  readonly #host: ChangeHost = {
    decider: () => this.#account().principal(),
    district: () => districtOf(this.env),
  };
  readonly #changes = changes.bind(this.#journal, this.#host);

  #account() {
    const namespace = this.ctx.exports.EducateOsAccountObject;
    return namespace.get(namespace.idFromString(this.ctx.props.accountObjectId));
  }

  /** Describes the school tools binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "educateos://tools",
      title: "School tools",
      snippet: "Your school's rosters, coursework and grades, with your access.",
      suggestedBindingName: "SCHOOL",
      tsType: "SchoolToolsSession",
    };
  }

  /** Returns the agent-facing declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** None: a person decides every school change. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /** Opens a session acting as the account's principal. */
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SchoolToolsSession> {
    // The queue is disposed when this call returns, so the session keeps its own copy.
    const queue = approvalQueue.dup();
    const core = new SchoolToolsSessionCore({
      district: districtOf(this.env),
      account: () => this.#account().principal(),
      observe: (read) => queue.authorizeObservation(describeRead(read)),
      submit: async (change) => void await this.#changes.submit(queue, "change", change),
    });
    return new SchoolToolsSessionImpl(core, queue);
  }

  /** Returns no catalog: the binding's types describe how to discover the tools. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /**
   * Refuses every collaborator. What was read is what the account's principal may see, and no
   * collaborator can be shown to be entitled to the same student records.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("School records read by this workspace cannot be shared with collaborators.");
  }

  /** Nothing is tracked. */
  async removeObserver(_id: string): Promise<void> {}

  /** Approves the change in the district as the account's principal. */
  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    await this.#changes.apply(actionId);
  }

  /** Declines the change in the district as the account's principal. */
  async rejectAction(actionId: number): Promise<void> {
    await this.#changes.reject(actionId);
  }

  revertAction(_action: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("School changes cannot be undone from the Workshop.");
  }
}

// ---------------------------------------------------------------------------
// Account, verifier and vendor.

type AccountProps = { accountObjectId: string };

/** A path the School app may request: under the district's `/api`, with no fragment. */
const DISTRICT_API_PATH = /^\/api\/[A-Za-z0-9._~%/-]*(?:\?[^#\s]*)?$/;

/** The largest request body the School app sends: a Common Cartridge upload is 5 MiB as base64 JSON. */
const MAX_REQUEST_BODY = 8 * 1024 * 1024;

/**
 * The School app's capability: the district's own screens, served as the account's person (see
 * README.md, "School pages"). The principal is read from the account on every request, so a
 * disconnected account's open page stops working at once.
 */
@validateRpc()
class SchoolAppApiImpl extends RpcTarget implements SchoolAppApi {
  readonly #env: Cloudflare.Env;
  readonly #account: DurableObjectStub<EducateOsAccountObject>;

  constructor(env: Cloudflare.Env, account: DurableObjectStub<EducateOsAccountObject>) {
    super();
    this.#env = env;
    this.#account = account;
  }

  async districtOrigin(): Promise<string | null> {
    return this.#env.DISTRICT_URL === undefined ? null : new URL(this.#env.DISTRICT_URL).origin;
  }

  async request(method: "GET" | "POST", path: string, body: string | null): Promise<DistrictResponse> {
    if (!DISTRICT_API_PATH.test(path) || path.includes("..")) throw new Error("The School app reaches only the district's API.");
    if (method === "GET" ? body !== null : body === null || body.length > MAX_REQUEST_BODY) {
      throw new Error("That request body is not one the district's API takes.");
    }
    const principal = await this.#account.principal();
    const response = await districtOf(this.#env).serveAs(principal, new Request(new URL(path, districtUrl(this.#env)), {
      method,
      headers: { accept: "application/json", ...(body === null ? {} : { "content-type": "application/json" }) },
      ...(body === null ? {} : { body }),
    }));
    return { status: response.status, body: await response.text(), correlationId: response.headers.get("x-correlation-id") };
  }
}

@validateRpc()
export class EducateOsAccount extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  /** Describes the account: an agent singleton, and the School app with its sidebar entries. */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "EducateOS",
      avatar: SCHOOL_ICON,
      singleton: { tsType: "SchoolToolsSession" },
      providesUi: { title: "School", icon: SCHOOL_ICON, nav: true },
    };
  }

  #accountObject(): DurableObjectStub<EducateOsAccountObject> {
    const namespace = this.ctx.exports.EducateOsAccountObject;
    return namespace.get(namespace.idFromString(this.ctx.props.accountObjectId));
  }

  /** Reads the district's API as the account's person. */
  #districtGet(principal: VerifiedPrincipal): DistrictGet {
    const district = districtOf(this.env);
    return async <T,>(path: string) => {
      const response = await district.serveAs(principal, new Request(new URL(path, districtUrl(this.env)), { headers: { accept: "application/json" } }));
      if (!response.ok) throw new Error(`The district answered ${response.status} for ${path}.`);
      return await response.json() as T;
    };
  }

  /** The School app: the district's screens, as the account's person. */
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    return { iframeHtml: APP_HTML, ui: new RpcStub(new SchoolAppApiImpl(this.env, this.#accountObject())) };
  }

  /** The School app's sidebar entries, from the person's roles, schools and classes. */
  async getAppNav(): Promise<GatekeeperAppNavEntry[]> {
    return schoolNav(await readSchoolNavFacts(this.#districtGet(await this.#accountObject().principal())));
  }

  /** Returns the workspace facet, bound to this account. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<SchoolToolsSession>>> {
    return this.ctx.exports.EducateOsGatekeeper({ props: { accountObjectId: this.ctx.props.accountObjectId } });
  }

  /** Returns no URL-addressed resources: the tools come as one binding. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("EducateOS has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("EducateOS has no URL-addressed resources.");
  }

  /** Confirms there are no resource scopes to grant. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Forgets the account and the principal it was verified as. */
  async revoke(): Promise<void> {
    await this.#accountObject().revoke();
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("A EducateOS account holds no credentials to renew. Disconnect it and connect again.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("A EducateOS account holds no credentials to renew.");
  }

  /** Returns no email: a school account is a district principal, never an address. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the verifier the Workshop requires; the facet admits no observer, so it is never asked. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.EducateOsVerifier({});
  }
}

@validateRpc()
export class EducateOsVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  /** Describes the EducateOS vendor. Accounts are connected, never auto-provisioned (README). */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "EducateOS",
      url: "https://educateos.io/",
      logo: SCHOOL_ICON,
      tagline: "Your school's tools, with your access",
      description: "Let your agent use your district's school tools as you: reading what you may read, "
        + "and asking you before it changes anything.",
      providesAuth: false,
    };
  }

  /** The version tag of this Worker's running version, for the deployment's admins. */
  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  /** Starts a connect flow, whose link the district's own sign-in completes. */
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const namespace = this.ctx.exports.EducateOsAccountObject;
    const id = namespace.newUniqueId();
    const nonce = generateNonce();
    await namespace.get(id).setCallback(callback, nonce);
    return { url: `${baseUrl(this.env)}/connect/${id.toString()}/${nonce}` };
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the agent-facing declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
