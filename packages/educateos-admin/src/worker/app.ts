// The admin Worker's routes (SCHO-263).
//
//   GET  /healthz                                            no sign-in
//   GET  /api/me                                             who is signed in, and the edition
//   GET  /api/workspaces                                     the registry
//   POST /api/workspaces                                     enroll: a new key pair and instructions
//   GET  /api/workspaces/:id                                 one workspace and its public key
//   POST /api/workspaces/:id/verify                          a signed health call; active on success
//   POST /api/workspaces/:id/remove                          retire the keys, drop cached analytics
//   GET  /api/workspaces/:id/health                          → GET  /api/ops/health
//   GET  /api/workspaces/:id/analytics?range&refresh         → GET  /api/ops/analytics (cached 5 min)
//   GET  /api/workspaces/:id/directory?query&role&status&cursor  → pass-through, never stored
//   GET  /api/workspaces/:id/directory/:principal            → pass-through, never stored
//   POST /api/workspaces/:id/directory/:principal/:action    → audited
//   GET  /api/workspaces/:id/devices?principal&status&cursor → pass-through, never stored
//   POST /api/workspaces/:id/devices/:device/revoke          → audited
//   POST /api/workspaces/:id/devices/revoke-below-version    → audited
//   GET  /api/workspaces/:id/releases                        → GET  /api/ops/releases
//   GET  /api/audit?workspace&cursor                         this admin's audit log
//
// Everything else is the SPA, from the assets binding. Every /api route verifies the Access
// assertion itself and checks ADMINS; mutations need the admin role, a JSON body and a same-origin
// request.
import { AccessUnavailableError, type OperatorVerifier } from "@educateos/control-plane/access";
import {
  AnalyticsRange,
  DirectoryAction,
  DirectoryActionBodies,
  OpsActionResult,
  OpsAnalyticsResponse,
  OpsDeviceId,
  OpsDevicesPage,
  OpsDevicesQuery,
  OpsDirectoryDetail,
  OpsDirectoryPage,
  OpsDirectoryQuery,
  OpsHealthResponse,
  OpsReleasesResponse,
  OpsRevokeBelowVersionBody,
  OpsRevokeBelowVersionResult,
  OpsRevokeDeviceBody,
  OpsScope,
  SigningIdentity,
} from "@educateos/fleet/ops";
import { PrincipalId } from "@educateos/contracts";
import type { z } from "zod";
import {
  EnrollmentRequest,
  type AnalyticsEnvelope,
  type EnrollmentResponse,
  type Me,
  type OperatorRole,
  type Workspace,
  type WorkspaceDetail,
} from "../shared/api.ts";
import { AdminConfigError, normalizeOrigin, originAllowed, roleFor, type AdminConfig, type AdminEntry } from "./config.ts";
import { callDistrict, DistrictError, type FetchLike } from "./district.ts";
import { KeyEncryptionError, openPrivateKey, sealPrivateKey } from "./keys.ts";
import type { AdminStore } from "./store.ts";

/** How long an analytics snapshot is served before the district is asked again. */
export const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/** The largest request body the admin's own API reads. */
const MAX_BODY_BYTES = 16 * 1024;

/** What {@link handleAdminRequest} is given. */
export interface AdminDeps {
  store: AdminStore;
  /** The edition and its restrictions. Throws {@link AdminConfigError} when misconfigured. */
  config: () => AdminConfig;
  admins: readonly AdminEntry[];
  verifyOperator: OperatorVerifier;
  /** The key that seals ops private keys. Throws {@link KeyEncryptionError} when missing. */
  keyEncryptionKey: () => Promise<CryptoKey>;
  /** Reaches districts. */
  fetchDistrict: FetchLike;
  /** The SPA's static files. Without it, non-API paths are 404. */
  assets?: (request: Request) => Promise<Response>;
  now?: () => Date;
  commit?: string;
}

/** A request the route refuses, with what to tell the caller. */
class Refusal extends Error {
  override readonly name = "Refusal";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: HEADERS });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ code, message }, status);
}

/** Routes one request. Unexpected failures are logged by error name only and answered 500. */
export async function handleAdminRequest(request: Request, deps: AdminDeps): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") return errorResponse(405, "method-not-allowed", "GET only.");
      const config = deps.config();
      return json({ status: "ok", edition: config.edition, ...(deps.commit ? { commit: deps.commit } : {}) });
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await api(request, url, deps);
    if (deps.assets !== undefined) return await deps.assets(request);
    return errorResponse(404, "not-found", "Not found.");
  } catch (error) {
    if (error instanceof Refusal) return errorResponse(error.status, error.code, error.message);
    if (error instanceof DistrictError) {
      const status = error.status === 404 ? 404 : error.status === 400 ? 400 : 502;
      return errorResponse(status, status === 502 ? "district-error" : error.status === 404 ? "not-found" : "validation-failed", error.message);
    }
    if (error instanceof AccessUnavailableError) return errorResponse(503, "unavailable", "Sign-in can't be checked right now. Try again shortly.");
    if (error instanceof AdminConfigError || error instanceof KeyEncryptionError) {
      console.error("admin misconfigured", { error: error.name, message: error.message });
      return errorResponse(503, "unavailable", "This admin is not configured correctly. Its operator has been told.");
    }
    console.error("admin request failed", { error: error instanceof Error ? error.name : typeof error });
    return errorResponse(500, "internal", "Something went wrong.");
  }
}

/** Who is making the request. */
interface Caller {
  sub: string;
  email: string;
  role: OperatorRole;
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new Refusal(413, "too-large", "The request body is too large.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Refusal(413, "too-large", "The request body is too large.");
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Refusal(400, "validation-failed", "The request body is not JSON.");
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Refusal(400, "validation-failed", `The ${what} is not valid.`);
  return result.data;
}

/** The query parameters a schema knows, taken from the URL, so nothing else is forwarded. */
function queryOf<T extends z.ZodObject>(schema: T, url: URL): z.infer<T> {
  const picked: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") picked[key] = value;
  }
  return parse(schema, picked, "query");
}

function opsTarget(path: string, query: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
  const search = params.toString();
  return search === "" ? path : `${path}?${search}`;
}

async function api(request: Request, url: URL, deps: AdminDeps): Promise<Response> {
  const config = deps.config();
  const identity = await deps.verifyOperator(request);
  if (identity === undefined) return errorResponse(401, "unauthenticated", "Sign in through Cloudflare Access to use this admin.");
  const role = roleFor(deps.admins, identity);
  if (role === undefined) return errorResponse(403, "forbidden", "You are signed in, but you are not an operator of this admin.");
  const now = (deps.now ?? (() => new Date()))();
  await deps.store.recordOperator(identity.subject, identity.email, role, now);
  const caller: Caller = { sub: identity.subject, email: identity.email, role };

  if (request.method === "POST") {
    // Same-origin JSON only, so another site can't make a signed-in operator's browser post here.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return errorResponse(403, "forbidden", "Cross-origin requests are refused.");
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return errorResponse(415, "unsupported-media-type", "Send JSON.");
    }
    if (caller.role !== "admin") return errorResponse(403, "forbidden", "Viewers can't make changes.");
  } else if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method-not-allowed", "Method not allowed.");
  }

  const parts = url.pathname.split("/").slice(2).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "\0";
    }
  });
  const route = `${request.method} ${parts.length > 0 ? parts[0] : ""}`;
  const context: RouteContext = { request, url, deps, config, caller, now };

  if (route === "GET me" && parts.length === 1) {
    const me: Me = {
      operator: { email: caller.email, role: caller.role },
      edition: config.edition,
      ...(config.allowedOrigins === undefined ? {} : { allowedOrigins: [...config.allowedOrigins] }),
    };
    return json(me);
  }
  if (route === "GET audit" && parts.length === 1) {
    const workspace = url.searchParams.get("workspace") ?? undefined;
    const cursor = url.searchParams.get("cursor");
    const before = cursor !== null && /^\d{1,15}$/.test(cursor) ? Number(cursor) : undefined;
    return json(await deps.store.auditPage({ ...(workspace === undefined ? {} : { workspaceId: workspace }), ...(before === undefined ? {} : { before }) }));
  }
  if (parts[0] === "workspaces") {
    if (parts.length === 1) {
      if (request.method === "GET") return json((await deps.store.workspaces()).filter((w) => originAllowed(config, w.origin)));
      return enroll(context);
    }
    return workspaceRoute(context, parts[1]!, parts.slice(2));
  }
  return errorResponse(404, "not-found", "No such API route.");
}

interface RouteContext {
  request: Request;
  url: URL;
  deps: AdminDeps;
  config: AdminConfig;
  caller: Caller;
  now: Date;
}

/** Every ops scope, which an enrollment asks the district for. */
const REQUESTED_SCOPES = [...OpsScope.options];

function workspaceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `wks_${[...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16)}`;
}

async function enroll({ request, url, deps, config, caller, now }: RouteContext): Promise<Response> {
  const input = parse(EnrollmentRequest, await readJson(request), "enrollment");
  const origin = normalizeOrigin(input.origin);
  if (origin === undefined) throw new Refusal(400, "validation-failed", "The origin must be https://<hostname>, with no path.");
  const audit = (result: string, workspaceIdValue?: string) =>
    deps.store.audit({ operatorSub: caller.sub, ...(workspaceIdValue ? { workspaceId: workspaceIdValue } : {}), action: "workspace.enroll", target: origin, result, at: now.toISOString() });
  if (!originAllowed(config, origin)) {
    await audit("refused:origin-not-allowed");
    throw new Refusal(403, "forbidden", "This admin can only manage the workspaces its configuration lists (OSS_WORKSPACE_ORIGINS).");
  }
  if (await deps.store.conflicting(input.slug, origin)) throw new Refusal(409, "conflict", "A workspace with this slug or origin is already enrolled.");

  const identity = await SigningIdentity.generate();
  const kek = await deps.keyEncryptionKey();
  const workspace: Workspace = {
    id: workspaceId(),
    slug: input.slug,
    displayName: input.displayName,
    origin,
    // The OSS admin manages districts in its own account, which are self-hosted by definition.
    edition: config.edition === "oss" ? "oss" : (input.edition ?? "hosted"),
    enrolledAt: now.toISOString(),
    status: "pending",
  };
  const publicJwk = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: identity.publicKey, kid: identity.keyId });
  await deps.store.enroll(workspace, {
    workspaceId: workspace.id,
    keyId: identity.keyId,
    publicJwk,
    sealedPrivateKey: await sealPrivateKey(kek, workspace.id, identity),
    createdAt: workspace.enrolledAt,
  });
  await audit("ok", workspace.id);

  const response: EnrollmentResponse = {
    workspace: { ...workspace, key: { keyId: identity.keyId, publicKey: identity.publicKey, createdAt: workspace.enrolledAt } },
    registration: { adminOrigin: url.origin, keyId: identity.keyId, publicKey: identity.publicKey, scopes: REQUESTED_SCOPES },
    instructions: [
      `Sign in to ${origin}/admin as a district administrator.`,
      "Open Operations, then Admin access, and choose Add an admin.",
      `Paste the registration below. It names this admin (${url.origin}) and its public key, ${identity.keyId}.`,
      "Choose which scopes to grant. The district can drop any scope, or remove this admin, at any time.",
      "Come back here and choose Verify connection.",
    ],
  };
  return json(response, 201);
}

async function loadWorkspace({ deps, config }: RouteContext, id: string): Promise<Workspace> {
  const workspace = await deps.store.workspace(id);
  // A workspace outside the OSS admin's configured origins is treated as absent, not forbidden.
  if (workspace === undefined || workspace.status === "removed" || !originAllowed(config, workspace.origin)) {
    throw new Refusal(404, "not-found", "No such workspace.");
  }
  return workspace;
}

async function signerFor({ deps }: RouteContext, workspace: Workspace): Promise<SigningIdentity> {
  const key = await deps.store.activeKey(workspace.id);
  if (key === undefined) throw new Refusal(409, "conflict", "This workspace has no ops key. Enroll it again.");
  return openPrivateKey(await deps.keyEncryptionKey(), workspace.id, key.keyId, key.sealedPrivateKey);
}

async function workspaceRoute(context: RouteContext, id: string, rest: string[]): Promise<Response> {
  const { request, url, deps, caller, now } = context;
  const workspace = await loadWorkspace(context, id);
  const method = request.method === "HEAD" ? "GET" : request.method;
  const call = async <T extends z.ZodType>(callMethod: "GET" | "POST", target: string, schema: T, body?: unknown) =>
    callDistrict({
      origin: workspace.origin,
      identity: await signerFor(context, workspace),
      operator: caller.email,
      method: callMethod,
      target,
      schema,
      fetch: deps.fetchDistrict,
      now,
      ...(body === undefined ? {} : { body }),
    });
  /** Runs an ops command and records it, whatever the outcome. */
  const audited = async <T>(action: string, target: string | undefined, run: () => Promise<T>, resultOf: (value: T) => string) => {
    const record = (result: string) =>
      deps.store.audit({ operatorSub: caller.sub, workspaceId: workspace.id, action, ...(target === undefined ? {} : { target }), result, at: now.toISOString() });
    let value: T;
    try {
      value = await run();
    } catch (error) {
      await record(error instanceof DistrictError ? error.result : error instanceof Refusal ? `refused:${error.status}` : "error");
      throw error;
    }
    await record(resultOf(value));
    return value;
  };

  const [section, second, third] = rest;
  const shape = `${method} ${rest.length} ${section ?? ""}`;

  switch (shape) {
    case "GET 0 ": {
      const key = await deps.store.activeKey(workspace.id);
      const detail: WorkspaceDetail = {
        ...workspace,
        ...(key === undefined ? {} : { key: { keyId: key.keyId, publicKey: (JSON.parse(key.publicJwk) as { x: string }).x, createdAt: key.createdAt } }),
      };
      return json(detail);
    }
    case "POST 1 verify": {
      const health = await audited("workspace.verify", undefined, () => call("GET", "/api/ops/health", OpsHealthResponse), () => "ok");
      if (workspace.status !== "active") await deps.store.setStatus(workspace.id, "active");
      return json({ workspace: { ...workspace, status: "active" }, health });
    }
    case "POST 1 remove": {
      await deps.store.remove(workspace.id, now);
      await deps.store.audit({ operatorSub: caller.sub, workspaceId: workspace.id, action: "workspace.remove", result: "ok", at: now.toISOString() });
      return json({ removed: true });
    }
    case "GET 1 health":
      return json(await call("GET", "/api/ops/health", OpsHealthResponse));
    case "GET 1 releases":
      return json(await call("GET", "/api/ops/releases", OpsReleasesResponse));
    case "GET 1 analytics":
      return json(await analytics(context, workspace, (target) => call("GET", target, OpsAnalyticsResponse)));
    case "GET 1 directory": {
      const query = queryOf(OpsDirectoryQuery, url);
      return json(await call("GET", opsTarget("/api/ops/directory", query), OpsDirectoryPage));
    }
    case "GET 2 directory": {
      const principal = parse(PrincipalId, second, "person");
      return json(await call("GET", `/api/ops/directory/${encodeURIComponent(principal)}`, OpsDirectoryDetail));
    }
    case "POST 3 directory": {
      const principal = parse(PrincipalId, second, "person");
      const action = parse(DirectoryAction, third, "action");
      const body = parse(DirectoryActionBodies[action], await readJson(request), "action");
      const result = await audited(
        `directory.${action}`,
        principal,
        () => call("POST", `/api/ops/directory/${encodeURIComponent(principal)}/${action}`, OpsActionResult, body),
        (value) => (value.applied ? "ok" : "unchanged"),
      );
      return json(result);
    }
    case "GET 1 devices": {
      const query = queryOf(OpsDevicesQuery, url);
      return json(await call("GET", opsTarget("/api/ops/devices", query), OpsDevicesPage));
    }
    case "POST 2 devices": {
      if (second !== "revoke-below-version") break;
      const body = parse(OpsRevokeBelowVersionBody, await readJson(request), "forced update");
      const result = await audited(
        "devices.revoke-below-version",
        `${body.platform ?? "all"}<${body.minimumVersion}`,
        () => call("POST", "/api/ops/devices/revoke-below-version", OpsRevokeBelowVersionResult, body),
        (value) => `ok:${value.revoked}`,
      );
      return json(result);
    }
    case "POST 3 devices": {
      if (third !== "revoke") break;
      const device = parse(OpsDeviceId, second, "device");
      const body = parse(OpsRevokeDeviceBody, await readJson(request), "revocation");
      const result = await audited(
        "devices.revoke",
        device,
        () => call("POST", `/api/ops/devices/${encodeURIComponent(device)}/revoke`, OpsActionResult, body),
        (value) => (value.applied ? "ok" : "unchanged"),
      );
      return json(result);
    }
  }
  return errorResponse(404, "not-found", "No such API route.");
}

/**
 * Analytics, served from the workspace's snapshot while it is under {@link SNAPSHOT_TTL_MS} old.
 * `refresh=1` asks the district regardless. When the district can't be reached, the last snapshot
 * is served, marked stale. Only the validated aggregates are ever stored.
 */
async function analytics(
  { url, deps, now }: RouteContext,
  workspace: Workspace,
  fetchAnalytics: (target: string) => Promise<OpsAnalyticsResponse>,
): Promise<AnalyticsEnvelope> {
  const range = parse(AnalyticsRange, url.searchParams.get("range") ?? "24h", "range");
  const refresh = url.searchParams.get("refresh") === "1";
  const cached = await deps.store.snapshot(workspace.id, range);
  const fromCache = (stale: boolean): AnalyticsEnvelope | undefined => {
    if (cached === undefined) return undefined;
    const parsed = OpsAnalyticsResponse.safeParse(JSON.parse(cached.json));
    return parsed.success ? { analytics: parsed.data, fetchedAt: cached.fetchedAt, cached: true, stale } : undefined;
  };
  if (cached !== undefined && !refresh && now.getTime() - Date.parse(cached.fetchedAt) < SNAPSHOT_TTL_MS) {
    const hit = fromCache(false);
    if (hit !== undefined) return hit;
  }
  let report: OpsAnalyticsResponse;
  try {
    report = await fetchAnalytics(opsTarget("/api/ops/analytics", { range }));
  } catch (error) {
    const unreachable = error instanceof DistrictError && (error.status === 0 || error.status >= 500);
    const stale = unreachable ? fromCache(true) : undefined;
    if (stale !== undefined) return stale;
    throw error;
  }
  if (report.range !== range) throw new DistrictError(200, "malformed", "The district answered for a different range.");
  const fetchedAt = now.toISOString();
  await deps.store.putSnapshot(workspace.id, range, JSON.stringify(report), fetchedAt);
  return { analytics: report, fetchedAt, cached: false, stale: false };
}
