import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK } from "jose";
import { z } from "zod";
import {
  EducateOsError,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type PrincipalId,
  type Scope,
  type VerifiedPrincipal,
} from "@educateos/contracts";
import { isDistrictAdmin } from "@educateos/academics";
import {
  DelegableKind,
  delegationInForce,
  Delegations,
  subjectFactsFrom,
  type DelegationStore,
  type PolicyDecider,
} from "@educateos/policy";
import {
  MCP_BEARER_TOKEN_PREFIX,
  sha256Hex,
  type McpBearerTokenStore,
  type McpRegisteredClientView,
} from "@educateos/district-app";
import type { DistrictSqlStorage } from "@educateos/district-app/durable-stores";
import type { McpAuthenticator } from "./index.ts";

/** Paths of the built-in Cloudflare OAuth 2.1 server that bypass Cloudflare Access. */
export const BUILTIN_OAUTH_BYPASS_PATHS: readonly string[] = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/jwks.json",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
];

/** The interactive consent/authorization endpoint, which MUST sit behind Cloudflare Access. */
export const BUILTIN_OAUTH_AUTHORIZE_PATH = "/oauth/authorize";

/** Access tokens minted by the built-in server live 10 minutes; refresh tokens rotate per use. */
export const BUILTIN_ACCESS_TOKEN_SECONDS = 600;
const AUTH_CODE_TTL_MS = 60_000;
const CONSENT_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_SECONDS = 30;
const MAX_BODY_BYTES = 65_536;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const CLIENT_ID_RE = /^[\x21-\x7e]{1,255}$/;
const MCP_SCOPE = "mcp:tools";

/** Persisted ES256 signing key pair for one district's built-in OAuth server. */
export interface StoredOAuthSigningKey {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
  createdAt: string;
}

/** One dynamically registered OAuth client (RFC 7591). */
export interface RegisteredOAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

/** One single-use OAuth authorization code record, keyed by SHA-256 of the code. */
export interface StoredAuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  principalId: PrincipalId;
  delegationId: string;
  expiresAt: number;
}

/** One CSRF consent record for GET -> POST `/oauth/authorize`, keyed by SHA-256 of the nonce. */
export interface StoredConsentNonce {
  principalId: PrincipalId;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state: string | undefined;
  expiresAt: number;
}

/** One rotating opaque refresh token record, keyed by SHA-256 of the token. */
export interface StoredRefreshToken {
  clientId: string;
  principalId: PrincipalId;
  delegationId: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

/**
 * Minimal storage contract for the built-in OAuth 2.1 authorization server.
 * Implementations must make `consume*` operations atomic so codes and refresh tokens are single-use.
 */
export interface McpOAuthStorage {
  getSigningKey(): Promise<StoredOAuthSigningKey | undefined>;
  setSigningKey(key: StoredOAuthSigningKey): Promise<void>;
  getClient(clientId: string): Promise<RegisteredOAuthClient | undefined>;
  putClient(client: RegisteredOAuthClient): Promise<void>;
  listClients(): Promise<RegisteredOAuthClient[]>;
  putAuthCode(codeHash: string, record: StoredAuthCode): Promise<void>;
  consumeAuthCode(codeHash: string): Promise<StoredAuthCode | undefined>;
  putConsentNonce(nonceHash: string, record: StoredConsentNonce): Promise<void>;
  consumeConsentNonce(nonceHash: string): Promise<StoredConsentNonce | undefined>;
  putRefreshToken(tokenHash: string, record: StoredRefreshToken): Promise<void>;
  /** Atomically removes a refresh token and leaves a tombstone so a replay can be detected. */
  consumeRefreshToken(tokenHash: string): Promise<StoredRefreshToken | undefined>;
  /** The record of a refresh token that was already consumed, if one is remembered. */
  findConsumedRefreshToken(tokenHash: string): Promise<StoredRefreshToken | undefined>;
  revokeRefreshToken(tokenHash: string): Promise<void>;
}

/** In-memory {@link McpOAuthStorage} for unit tests and the local harness. */
export class InMemoryMcpOAuthStorage implements McpOAuthStorage {
  #key: StoredOAuthSigningKey | undefined;
  readonly #clients = new Map<string, RegisteredOAuthClient>();
  readonly #codes = new Map<string, StoredAuthCode>();
  readonly #consents = new Map<string, StoredConsentNonce>();
  readonly #refreshes = new Map<string, StoredRefreshToken>();
  readonly #consumedRefreshes = new Map<string, StoredRefreshToken>();

  async getSigningKey() { return this.#key === undefined ? undefined : structuredClone(this.#key); }
  async setSigningKey(key: StoredOAuthSigningKey) { this.#key = structuredClone(key); }
  async getClient(clientId: string) { const c = this.#clients.get(clientId); return c ? structuredClone(c) : undefined; }
  async putClient(client: RegisteredOAuthClient) { this.#clients.set(client.clientId, structuredClone(client)); }
  async listClients() { return [...this.#clients.values()].map((c) => structuredClone(c)); }
  async putAuthCode(codeHash: string, record: StoredAuthCode) { this.#codes.set(codeHash, structuredClone(record)); }
  async consumeAuthCode(codeHash: string) {
    const found = this.#codes.get(codeHash);
    this.#codes.delete(codeHash);
    return found ? structuredClone(found) : undefined;
  }
  async putConsentNonce(nonceHash: string, record: StoredConsentNonce) { this.#consents.set(nonceHash, structuredClone(record)); }
  async consumeConsentNonce(nonceHash: string) {
    const found = this.#consents.get(nonceHash);
    this.#consents.delete(nonceHash);
    return found ? structuredClone(found) : undefined;
  }
  async putRefreshToken(tokenHash: string, record: StoredRefreshToken) { this.#refreshes.set(tokenHash, structuredClone(record)); }
  async consumeRefreshToken(tokenHash: string) {
    const found = this.#refreshes.get(tokenHash);
    this.#refreshes.delete(tokenHash);
    if (found !== undefined) this.#consumedRefreshes.set(tokenHash, structuredClone(found));
    return found ? structuredClone(found) : undefined;
  }
  async findConsumedRefreshToken(tokenHash: string) {
    const found = this.#consumedRefreshes.get(tokenHash);
    return found ? structuredClone(found) : undefined;
  }
  async revokeRefreshToken(tokenHash: string) { this.#refreshes.delete(tokenHash); }
}

/** Durable Object SQLite {@link McpOAuthStorage}, using one atomic transaction per operation. */
export class DurableObjectMcpOAuthStorage implements McpOAuthStorage {
  readonly #storage: DistrictSqlStorage;
  #ready = false;

  constructor(storage: DistrictSqlStorage) {
    this.#storage = storage;
  }

  #tx<T>(fn: (sql: DistrictSqlStorage["sql"]) => T): T {
    return this.#storage.transactionSync(() => {
      if (!this.#ready) {
        this.#storage.sql.exec("CREATE TABLE IF NOT EXISTS educateos_mcp_oauth_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
        this.#storage.sql.exec("CREATE TABLE IF NOT EXISTS educateos_mcp_oauth_clients (seq INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL UNIQUE, client_json TEXT NOT NULL)");
        this.#ready = true;
      }
      return fn(this.#storage.sql);
    });
  }

  #getKv<T>(key: string): T | undefined {
    return this.#tx((sql) => {
      const [row] = sql.exec("SELECT v FROM educateos_mcp_oauth_kv WHERE k = ?", key).toArray();
      return row === undefined ? undefined : JSON.parse(String(row.v)) as T;
    });
  }

  #putKv(key: string, value: unknown): void {
    this.#tx((sql) => {
      sql.exec("INSERT INTO educateos_mcp_oauth_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", key, JSON.stringify(value));
    });
  }

  #consumeKv<T>(key: string): T | undefined {
    return this.#tx((sql) => {
      const [row] = sql.exec("SELECT v FROM educateos_mcp_oauth_kv WHERE k = ?", key).toArray();
      if (row === undefined) return undefined;
      sql.exec("DELETE FROM educateos_mcp_oauth_kv WHERE k = ?", key);
      return JSON.parse(String(row.v)) as T;
    });
  }

  async getSigningKey() { return this.#getKv<StoredOAuthSigningKey>("signing_key"); }
  async setSigningKey(key: StoredOAuthSigningKey) { this.#putKv("signing_key", key); }
  async getClient(clientId: string) {
    return this.#tx((sql) => {
      const [row] = sql.exec("SELECT client_json FROM educateos_mcp_oauth_clients WHERE client_id = ?", clientId).toArray();
      return row === undefined ? undefined : JSON.parse(String(row.client_json)) as RegisteredOAuthClient;
    });
  }
  async putClient(client: RegisteredOAuthClient) {
    this.#tx((sql) => {
      sql.exec(
        "INSERT INTO educateos_mcp_oauth_clients (client_id, client_json) VALUES (?, ?) ON CONFLICT (client_id) DO UPDATE SET client_json = excluded.client_json",
        client.clientId,
        JSON.stringify(client),
      );
    });
  }
  async listClients() {
    return this.#tx((sql) =>
      sql.exec("SELECT client_json FROM educateos_mcp_oauth_clients ORDER BY seq").toArray()
        .map((row) => JSON.parse(String(row.client_json)) as RegisteredOAuthClient),
    );
  }
  async putAuthCode(codeHash: string, record: StoredAuthCode) { this.#putKv(`code:${codeHash}`, record); }
  async consumeAuthCode(codeHash: string) { return this.#consumeKv<StoredAuthCode>(`code:${codeHash}`); }
  async putConsentNonce(nonceHash: string, record: StoredConsentNonce) { this.#putKv(`consent:${nonceHash}`, record); }
  async consumeConsentNonce(nonceHash: string) { return this.#consumeKv<StoredConsentNonce>(`consent:${nonceHash}`); }
  async putRefreshToken(tokenHash: string, record: StoredRefreshToken) { this.#putKv(`refresh:${tokenHash}`, record); }
  async consumeRefreshToken(tokenHash: string) {
    return this.#tx((sql) => {
      const [row] = sql.exec("SELECT v FROM educateos_mcp_oauth_kv WHERE k = ?", `refresh:${tokenHash}`).toArray();
      if (row === undefined) return undefined;
      sql.exec("DELETE FROM educateos_mcp_oauth_kv WHERE k = ?", `refresh:${tokenHash}`);
      sql.exec("INSERT INTO educateos_mcp_oauth_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", `refresh-used:${tokenHash}`, String(row.v));
      return JSON.parse(String(row.v)) as StoredRefreshToken;
    });
  }
  async findConsumedRefreshToken(tokenHash: string) { return this.#getKv<StoredRefreshToken>(`refresh-used:${tokenHash}`); }
  async revokeRefreshToken(tokenHash: string) {
    this.#tx((sql) => { sql.exec("DELETE FROM educateos_mcp_oauth_kv WHERE k = ?", `refresh:${tokenHash}`); });
  }
}

/** Options for {@link createBuiltInMcpOAuth}. */
export interface BuiltInMcpOAuthOptions {
  /** Exact district public origin, e.g. `https://school.example.org`. */
  origin: string;
  /** The district ID. */
  districtId: DistrictId;
  /** Exact browser origins allowed for CORS on metadata/token/register endpoints. */
  allowedOrigins: readonly string[];
  /** Durable OAuth state (signing key, registered clients, auth codes, refresh tokens). */
  storage: McpOAuthStorage;
  /** Live directory snapshot reader (read on every authentication and consent). */
  directory: () => Promise<DistrictDirectorySnapshot>;
  /** Live delegation store (IF-06). */
  delegations: DelegationStore;
  /** Policy decider for issuing/revoking delegations during OAuth consent. */
  policy: PolicyDecider;
  /** Scoped personal bearer token store (`edum_*`). */
  mcpTokens: McpBearerTokenStore;
  /** Verifies a browser request on `/oauth/authorize` via Cloudflare Access and returns its active principal. */
  authenticateBrowser: (request: Request) => Promise<VerifiedPrincipal | null>;
  /** Optional fallback external OAuth resource authenticator (e.g. Nathan). */
  externalAuthenticator?: McpAuthenticator;
  /** Fetches Client ID Metadata Documents (defaults to global `fetch`). */
  fetchClientMetadata?: typeof fetch;
  /** Clock in milliseconds. */
  now?: () => number;
}

/** Built-in OAuth 2.1 HTTP handler + combined MCP bearer authenticator. */
export interface BuiltInMcpOAuth extends McpAuthenticator {
  /** Handles metadata, JWKS, DCR, `/oauth/authorize`, `/oauth/token` and `/oauth/revoke`. */
  fetch(request: Request): Promise<Response>;
  /** Lists registered OAuth clients for the Admin Management UI. */
  listClients(): Promise<McpRegisteredClientView[]>;
}

const RegistrationBody = z.object({
  client_name: z.string().trim().min(1).max(120).optional(),
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(20),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
});

const unauthenticated = () => new EducateOsError("unauthenticated", "The access token was not accepted.");
const forbidden = () => new EducateOsError("forbidden", "No delegation from this person to this client is in force.");

/** Whether `raw` is a safe OAuth redirect URI: HTTPS or loopback HTTP (for local editors/CLI), never fragments/userinfo. */
export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  return false;
}

function isHttpsClientMetadataUrl(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.pathname !== "/";
  } catch {
    return false;
  }
}

const CLIENT_METADATA_MAX_BYTES = 5 * 1024;
const CLIENT_METADATA_TIMEOUT_MS = 5000;
const ClientMetadataDocument = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(120).optional(),
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(20),
});
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * Fetches and validates a Client ID Metadata Document: HTTPS only, no redirects, bounded in size
 * and time, and its `client_id` must be exactly the URL it was fetched from. Returns undefined
 * when the document is unusable, so the client is treated as unknown.
 */
async function resolveClientMetadata(fetchImpl: typeof fetch, clientId: string): Promise<{ clientName: string; redirectUris: string[] } | undefined> {
  try {
    const response = await fetchImpl(clientId, {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS),
    });
    if (response.status !== 200 || response.body === null) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CLIENT_METADATA_MAX_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = ClientMetadataDocument.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success || parsed.data.client_id !== clientId || !parsed.data.redirect_uris.every(isAllowedRedirectUri)) return undefined;
    return { clientName: parsed.data.client_name ?? new URL(clientId).hostname, redirectUris: parsed.data.redirect_uris };
  } catch {
    return undefined;
  }
}

function randomHex(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function base64urlSha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...extraHeaders },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    },
  });
}

async function readBoundedText(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("Body too large");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

interface ScopeOption {
  id: string;
  label: string;
  scope: Scope;
}

function staffScopeOptions(snapshot: DistrictDirectorySnapshot, principalId: PrincipalId, at: Date): ScopeOption[] {
  const facts = subjectFactsFrom(snapshot, principalId, at);
  if (facts === undefined || !facts.active) return [];
  const options: ScopeOption[] = [];
  const seen = new Set<string>();
  const add = (id: string, label: string, scope: Scope) => {
    const key = JSON.stringify(scope);
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ id, label, scope });
  };
  const admin = isDistrictAdmin(snapshot, principalId, at);
  if (admin || facts.roles.some((r) => r.scope.level === "district" && ["district-admin", "curriculum-admin"].includes(r.role))) {
    add("district", `Whole district (${snapshot.district.name})`, { level: "district", districtId: snapshot.district.id });
  }
  for (const school of snapshot.schools) {
    if (admin || facts.roles.some((r) => ["school-admin", "curriculum-admin"].includes(r.role) && (r.scope.level === "district" || (r.scope.level === "school" && r.scope.schoolId === school.id)))) {
      add(`school:${school.id}`, `School: ${school.name}`, { level: "school", districtId: snapshot.district.id, schoolId: school.id });
    }
  }
  for (const offering of snapshot.offerings) {
    const teaches = snapshot.enrollments.some((e) => e.offeringId === offering.id && e.principalId === principalId && (e.role === "teacher" || e.role === "co-teacher") && e.status === "active");
    const overSchool = facts.roles.some((r) => ["school-admin", "curriculum-admin"].includes(r.role) && r.scope.level === "school" && r.scope.schoolId === offering.schoolId);
    if (!admin && !teaches && !overSchool) continue;
    const course = snapshot.courses.find((c) => c.id === offering.courseId);
    const term = snapshot.terms.find((t) => t.id === offering.termId);
    add(
      `offering:${offering.id}`,
      `Class: ${course?.title ?? offering.courseId} · ${offering.sectionName}${term ? ` (${term.name})` : ""}`,
      { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
    );
  }
  return options;
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #ffffff; --fg: #181a1f; --muted: #5a606c; --line: #dcdfe6; --accent: #1d5bd6; --accent-fg: #ffffff; --danger: #b42318; }
@media (prefers-color-scheme: dark) { :root { --bg: #111318; --card: #1a1d24; --fg: #eceef3; --muted: #9aa2b1; --line: #2d323e; --accent: #6ea0ff; --accent-fg: #0b1220; --danger: #f97066; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 32rem; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1.75rem; box-shadow: 0 2px 10px rgb(0 0 0 / 0.08); }
h1 { margin: 0 0 0.35rem; font-size: 1.25rem; }
p { margin: 0.5rem 0; color: var(--muted); }
.meta { margin: 1rem 0; padding: 0.75rem 0.9rem; border-radius: 10px; border: 1px solid var(--line); font-size: 0.9rem; }
.meta strong { color: var(--fg); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; word-break: break-all; }
label { display: block; font-weight: 600; margin: 1rem 0 0.35rem; }
select { width: 100%; padding: 0.55rem 0.65rem; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
.note { font-size: 0.85rem; color: var(--muted); margin-top: 0.75rem; }
.actions { display: flex; gap: 0.75rem; margin-top: 1.4rem; }
button { flex: 1; padding: 0.65rem 1rem; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; border: 1px solid var(--line); }
button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
button.secondary { background: transparent; color: var(--fg); }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/**
 * Creates a self-contained OAuth 2.1 Authorization Server (RFC 8414, RFC 7591 DCR, PKCE S256,
 * RFC 8707 resource binding, RFC 9207 `iss`, ES256 `at+jwt` + rotating refresh tokens) backed by
 * Cloudflare Access on `/oauth/authorize`, plus scoped personal bearer token authentication (`edum_*`).
 */
export function createBuiltInMcpOAuth(options: BuiltInMcpOAuthOptions): BuiltInMcpOAuth {
  const origin = new URL(options.origin).origin;
  const resource = `${origin}/mcp`;
  const now = options.now ?? Date.now;

  let cachedKey: Promise<{ kid: string; privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JWK }> | undefined;

  async function signingKey() {
    cachedKey ??= (async () => {
      let stored = await options.storage.getSigningKey();
      if (stored === undefined) {
        const pair = await generateKeyPair("ES256", { extractable: true });
        const kid = `eos-mcp-${randomHex(8)}`;
        const privateJwk = await exportJWK(pair.privateKey);
        const publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" };
        stored = { kid, privateJwk, publicJwk, createdAt: new Date(now()).toISOString() };
        await options.storage.setSigningKey(stored);
      }
      const privateKey = await importJWK(stored.privateJwk, "ES256") as CryptoKey;
      const publicKey = await importJWK(stored.publicJwk, "ES256") as CryptoKey;
      return { kid: stored.kid, privateKey, publicKey, publicJwk: stored.publicJwk };
    })().catch((err: unknown) => {
      cachedKey = undefined;
      throw err;
    });
    return cachedKey;
  }

  function applyCors(request: Request, response: Response): Response {
    const reqOrigin = request.headers.get("origin");
    if (!reqOrigin || !options.allowedOrigins.includes(reqOrigin)) return response;
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", reqOrigin);
    headers.set("vary", "Origin");
    return new Response(response.body, { status: response.status, headers });
  }

  async function issueAccessToken(principalId: PrincipalId, clientId: string, delegationId: string, scope: string): Promise<{ accessToken: string; expiresIn: number }> {
    const key = await signingKey();
    const iat = Math.floor(now() / 1000);
    const exp = iat + BUILTIN_ACCESS_TOKEN_SECONDS;
    const accessToken = await new SignJWT({
      iss: origin,
      sub: principalId,
      aud: resource,
      client_id: clientId,
      scope,
      delegation_id: delegationId,
      iat,
      exp,
    })
      .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: key.kid })
      .sign(key.privateKey);
    return { accessToken, expiresIn: BUILTIN_ACCESS_TOKEN_SECONDS };
  }

  /** Revokes one delegation as its grantor; already-revoked or missing delegations are ignored. */
  async function revokeDelegation(principalId: PrincipalId, delegationId: string): Promise<void> {
    const delegation = await options.delegations.get(delegationId as never);
    if (delegation === undefined || !delegationInForce(delegation, new Date(now()))) return;
    await new Delegations({ store: options.delegations, policy: options.policy, now: () => new Date(now()) })
      .revoke({ principal: { districtId: options.districtId, principalId }, channel: "http" }, delegation.id)
      .catch(() => undefined);
  }

  async function handleAuthorizeGet(request: Request): Promise<Response> {
    const principal = await options.authenticateBrowser(request);
    if (principal === null || principal.districtId !== options.districtId) {
      return htmlResponse(renderPage("Sign-in required", "<h1>Sign-in required</h1><p>Sign in through your school's Cloudflare Access login to connect an AI tool.</p>"), 401);
    }
    const snapshot = await options.directory();
    const person = snapshot.principals.find((p) => p.id === principal.principalId && p.status === "active");
    if (person === undefined || person.kind !== "staff") {
      return htmlResponse(renderPage("Staff only", "<h1>Staff accounts only</h1><p>Only active district teachers and administrators can connect external AI clients to this school's MCP server.</p>"), 403);
    }
    const url = new URL(request.url);
    const responseType = url.searchParams.get("response_type");
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";
    const state = url.searchParams.get("state") ?? undefined;
    const requestedResource = url.searchParams.get("resource") ?? resource;
    const rawScope = url.searchParams.get("scope") ?? MCP_SCOPE;

    if (responseType !== "code") {
      return htmlResponse(renderPage("Unsupported request", "<h1>Unsupported response_type</h1><p>Only OAuth 2.1 authorization code flow (<code>response_type=code</code>) is supported.</p>"), 400);
    }
    if (!CLIENT_ID_RE.test(clientId)) {
      return htmlResponse(renderPage("Invalid client", "<h1>Invalid client_id</h1><p>The client did not send a valid OAuth client identifier.</p>"), 400);
    }
    const registered = await options.storage.getClient(clientId);
    let clientName: string;
    if (registered !== undefined) {
      if (!registered.redirectUris.includes(redirectUri)) {
        return htmlResponse(renderPage("Invalid redirect URI", "<h1>Redirect URI mismatch</h1><p>The redirect URI does not match this registered client.</p>"), 400);
      }
      clientName = registered.clientName;
    } else if (isHttpsClientMetadataUrl(clientId)) {
      const metadata = await resolveClientMetadata(options.fetchClientMetadata ?? fetch, clientId);
      if (metadata === undefined) {
        return htmlResponse(renderPage("Invalid client", "<h1>Client metadata unavailable</h1><p>The client's metadata document could not be fetched or did not name this client.</p>"), 400);
      }
      if (!metadata.redirectUris.includes(redirectUri)) {
        return htmlResponse(renderPage("Invalid redirect URI", "<h1>Redirect URI mismatch</h1><p>The redirect URI is not listed in the client's metadata document.</p>"), 400);
      }
      clientName = metadata.clientName;
    } else {
      return htmlResponse(renderPage("Unknown client", "<h1>Unknown OAuth client</h1><p>Register the client first via Dynamic Client Registration (<code>/oauth/register</code>) or use an HTTPS Client ID Metadata Document URL.</p>"), 400);
    }
    if (codeChallengeMethod !== "S256" || !CODE_CHALLENGE.test(codeChallenge)) {
      return htmlResponse(renderPage("PKCE required", "<h1>PKCE S256 required</h1><p>This authorization server requires PKCE with <code>code_challenge_method=S256</code>.</p>"), 400);
    }
    if (requestedResource !== resource) {
      return htmlResponse(renderPage("Invalid resource", "<h1>Invalid resource</h1><p>Only this district's MCP endpoint is authorized here.</p>"), 400);
    }
    const scopes = rawScope.split(" ").filter(Boolean);
    const scope = scopes.includes(MCP_SCOPE) ? MCP_SCOPE : MCP_SCOPE;
    const optionsList = staffScopeOptions(snapshot, principal.principalId, new Date(now()));
    if (optionsList.length === 0) {
      return htmlResponse(renderPage("No delegable classes", "<h1>No classes or schools to connect</h1><p>Your account has no active teaching or administrative role in this district yet.</p>"), 403);
    }

    const nonce = randomHex(24);
    await options.storage.putConsentNonce(await sha256Hex(nonce), {
      principalId: principal.principalId,
      clientId,
      clientName,
      redirectUri,
      codeChallenge,
      resource,
      scope,
      state,
      expiresAt: now() + CONSENT_TTL_MS,
    });

    const scopeHtml = optionsList
      .map((item, i) => `<option value="${escapeHtml(item.id)}"${i === 0 ? " selected" : ""}>${escapeHtml(item.label)}</option>`)
      .join("");

    return htmlResponse(renderPage(
      `Connect ${clientName} to ${snapshot.district.name}`,
      `<h1>Connect AI tool</h1>
<p><strong>${escapeHtml(clientName)}</strong> is asking to access <strong>${escapeHtml(snapshot.district.name)}</strong> over MCP on your behalf.</p>
<div class="meta">
  <div><strong>Signed in as:</strong> ${escapeHtml(person.displayName)}</div>
  <div><strong>Client ID:</strong> <span class="mono">${escapeHtml(clientId)}</span></div>
  <div><strong>Sends you back to:</strong> <span class="mono">${escapeHtml(new URL(redirectUri).host)}</span></div>
  <div><strong>MCP endpoint:</strong> <span class="mono">${escapeHtml(resource)}</span></div>
</div>
<form method="POST" action="${BUILTIN_OAUTH_AUTHORIZE_PATH}">
  <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
  <label for="scopeId">Scope of access</label>
  <select id="scopeId" name="scopeId">${scopeHtml}</select>
  <label for="access">Allowed operations</label>
  <select id="access" name="access">
    <option value="read-only">Read only (view classes, rosters, modules, assignments, submissions, quizzes, discussions)</option>
    <option value="read-write" selected>Read + drafts &amp; queued writes (consequential changes wait in your approval queue)</option>
  </select>
  <label for="durationHours">Expires after</label>
  <select id="durationHours" name="durationHours">
    <option value="24">24 hours</option>
    <option value="168">7 days</option>
    <option value="720" selected>30 days</option>
    <option value="2160">90 days (maximum)</option>
  </select>
  <p class="note">Official grade approvals, identity links, admin grants, and student data deletions are never exposed over MCP. You can revoke this connection at any time in your school's Management UI.</p>
  <div class="actions">
    <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
    <button type="submit" name="decision" value="approve" class="primary">Approve connection</button>
  </div>
</form>`,
    ));
  }

  async function handleAuthorizePost(request: Request): Promise<Response> {
    const principal = await options.authenticateBrowser(request);
    if (principal === null || principal.districtId !== options.districtId) {
      return htmlResponse(renderPage("Sign-in required", "<h1>Sign-in required</h1><p>Your Cloudflare Access session is missing or expired.</p>"), 401);
    }
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    if (contentType !== "application/x-www-form-urlencoded") {
      return htmlResponse(renderPage("Invalid form", "<h1>Invalid form submission</h1>"), 400);
    }
    let bodyText: string;
    try {
      bodyText = await readBoundedText(request);
    } catch {
      return htmlResponse(renderPage("Request too large", "<h1>Request too large</h1>"), 413);
    }
    const form = new URLSearchParams(bodyText);
    const nonce = form.get("nonce") ?? "";
    if (!nonce) return htmlResponse(renderPage("Expired request", "<h1>Authorization expired</h1><p>Start the connection again from your AI client.</p>"), 400);

    const consent = await options.storage.consumeConsentNonce(await sha256Hex(nonce));
    if (consent === undefined || consent.expiresAt <= now() || consent.principalId !== principal.principalId) {
      return htmlResponse(renderPage("Expired request", "<h1>Authorization expired</h1><p>This consent screen expired or was already used. Start again from your AI client.</p>"), 400);
    }

    const redirect = new URL(consent.redirectUri);
    if (form.get("decision") !== "approve") {
      redirect.searchParams.set("error", "access_denied");
      if (consent.state !== undefined) redirect.searchParams.set("state", consent.state);
      redirect.searchParams.set("iss", origin);
      return Response.redirect(redirect.toString(), 302);
    }

    const snapshot = await options.directory();
    const at = new Date(now());
    const person = snapshot.principals.find((p) => p.id === principal.principalId && p.status === "active");
    if (person === undefined || person.kind !== "staff") {
      return htmlResponse(renderPage("Staff only", "<h1>Staff accounts only</h1>"), 403);
    }
    const chosenScope = staffScopeOptions(snapshot, principal.principalId, at).find((s) => s.id === form.get("scopeId"));
    if (chosenScope === undefined) {
      return htmlResponse(renderPage("Invalid scope", "<h1>Invalid scope selection</h1><p>You no longer hold a staff role over that scope.</p>"), 403);
    }
    const access = form.get("access") === "read-only" ? "read-only" : "read-write";
    const parsedDuration = Number(form.get("durationHours") ?? "720");
    const durationHours = Number.isInteger(parsedDuration) && parsedDuration >= 1 && parsedDuration <= 90 * 24 ? parsedDuration : 720;

    const delegationsService = new Delegations({ store: options.delegations, policy: options.policy, now: () => at });
    const caller = { principal, channel: "http" as const };
    // Keep at most one active delegation per (principal, client) so authorization is never ambiguous.
    for (const existing of await options.delegations.list()) {
      if (
        existing.districtId === options.districtId &&
        existing.grantorPrincipalId === principal.principalId &&
        existing.client.issuer === origin &&
        existing.client.clientId === consent.clientId &&
        delegationInForce(existing, at)
      ) {
        await delegationsService.revoke(caller, existing.id);
      }
    }

    const delegation = await delegationsService.issue(caller, {
      client: { issuer: origin, clientId: consent.clientId },
      ceiling: {
        scope: chosenScope.scope,
        actions: access === "read-only"
          ? ["read", "list", "invoke-tool"]
          : ["read", "list", "create", "update", "review", "invoke-tool"],
        kinds: [...DelegableKind.options],
        classifications: ["public", "district-internal", "course", "teacher-only"],
      },
      durationHours,
    });

    const code = `edua_${randomHex(32)}`;
    await options.storage.putAuthCode(await sha256Hex(code), {
      clientId: consent.clientId,
      redirectUri: consent.redirectUri,
      codeChallenge: consent.codeChallenge,
      resource: consent.resource,
      scope: consent.scope,
      principalId: principal.principalId,
      delegationId: delegation.id,
      expiresAt: now() + AUTH_CODE_TTL_MS,
    });

    redirect.searchParams.set("code", code);
    if (consent.state !== undefined) redirect.searchParams.set("state", consent.state);
    redirect.searchParams.set("iss", origin);
    return Response.redirect(redirect.toString(), 302);
  }

  async function handleRegister(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return jsonResponse({ error: "invalid_client_metadata" }, 415);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readBoundedText(request));
    } catch {
      return jsonResponse({ error: "invalid_client_metadata" }, 400);
    }
    const parsed = RegistrationBody.safeParse(raw);
    if (!parsed.success || !parsed.data.redirect_uris.every(isAllowedRedirectUri)) {
      return jsonResponse({ error: "invalid_redirect_uri", error_description: "Each redirect_uri must be HTTPS or loopback." }, 400);
    }
    const client: RegisteredOAuthClient = {
      clientId: `mcpc_${crypto.randomUUID()}`,
      clientName: parsed.data.client_name ?? new URL(parsed.data.redirect_uris[0]!).hostname,
      redirectUris: parsed.data.redirect_uris,
      createdAt: new Date(now()).toISOString(),
    };
    await options.storage.putClient(client);
    return jsonResponse({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: MCP_SCOPE,
    }, 201);
  }

  async function readTokenParams(request: Request): Promise<Record<string, string> | undefined> {
    const ct = request.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    let text: string;
    try {
      text = await readBoundedText(request);
    } catch {
      return undefined;
    }
    if (ct === "application/x-www-form-urlencoded") {
      return Object.fromEntries(new URLSearchParams(text));
    }
    if (ct === "application/json") {
      try {
        const obj = JSON.parse(text) as Record<string, unknown>;
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return undefined;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "string") out[k] = v;
        }
        return out;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async function handleToken(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const params = await readTokenParams(request);
    if (params === undefined) return jsonResponse({ error: "invalid_request" }, 400);

    const grantType = params.grant_type;
    if (grantType === "authorization_code") {
      const code = params.code ?? "";
      const codeVerifier = params.code_verifier ?? "";
      const clientId = params.client_id ?? "";
      const redirectUri = params.redirect_uri ?? "";
      const requestedResource = params.resource;
      if (!code || !CODE_VERIFIER.test(codeVerifier) || !clientId || !redirectUri) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }
      if (requestedResource !== undefined && requestedResource !== resource) {
        return jsonResponse({ error: "invalid_target" }, 400);
      }
      const stored = await options.storage.consumeAuthCode(await sha256Hex(code));
      if (
        stored === undefined ||
        stored.expiresAt <= now() ||
        stored.clientId !== clientId ||
        stored.redirectUri !== redirectUri
      ) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      const computedChallenge = await base64urlSha256(codeVerifier);
      if (!timingSafeEqual(computedChallenge, stored.codeChallenge)) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      const snapshot = await options.directory();
      const active = snapshot.principals.some((p) => p.id === stored.principalId && p.districtId === options.districtId && p.status === "active");
      const delegation = await options.delegations.get(stored.delegationId as never);
      if (!active || delegation === undefined || !delegationInForce(delegation, new Date(now()))) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      const { accessToken, expiresIn } = await issueAccessToken(stored.principalId, stored.clientId, delegation.id, stored.scope);
      const refreshToken = `edur_${randomHex(32)}`;
      await options.storage.putRefreshToken(await sha256Hex(refreshToken), {
        clientId: stored.clientId,
        principalId: stored.principalId,
        delegationId: delegation.id,
        resource: stored.resource,
        scope: stored.scope,
        expiresAt: Date.parse(delegation.expiresAt),
      });
      return jsonResponse({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: refreshToken,
        scope: stored.scope,
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = params.refresh_token ?? "";
      const clientId = params.client_id ?? "";
      if (!refreshToken || !clientId) return jsonResponse({ error: "invalid_request" }, 400);
      const refreshHash = await sha256Hex(refreshToken);
      const stored = await options.storage.consumeRefreshToken(refreshHash);
      if (stored === undefined) {
        // A consumed refresh token presented again means the chain leaked: end the delegation.
        const replayed = await options.storage.findConsumedRefreshToken(refreshHash);
        if (replayed !== undefined) await revokeDelegation(replayed.principalId, replayed.delegationId);
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      if (stored.expiresAt <= now() || stored.clientId !== clientId) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      const snapshot = await options.directory();
      const active = snapshot.principals.some((p) => p.id === stored.principalId && p.districtId === options.districtId && p.status === "active");
      const delegation = await options.delegations.get(stored.delegationId as never);
      if (!active || delegation === undefined || !delegationInForce(delegation, new Date(now()))) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      const { accessToken, expiresIn } = await issueAccessToken(stored.principalId, stored.clientId, delegation.id, stored.scope);
      const nextRefresh = `edur_${randomHex(32)}`;
      await options.storage.putRefreshToken(await sha256Hex(nextRefresh), {
        ...stored,
        expiresAt: Math.min(stored.expiresAt, Date.parse(delegation.expiresAt)),
      });
      return jsonResponse({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: nextRefresh,
        scope: stored.scope,
      });
    }

    return jsonResponse({ error: "unsupported_grant_type" }, 400);
  }

  async function handleRevoke(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const params = await readTokenParams(request);
    const token = params?.token;
    if (token) {
      const hash = await sha256Hex(token);
      const refresh = await options.storage.consumeRefreshToken(hash);
      if (refresh !== undefined) await revokeDelegation(refresh.principalId, refresh.delegationId);
      if (token.startsWith(MCP_BEARER_TOKEN_PREFIX)) {
        const record = await options.mcpTokens.findByDigest(hash);
        if (record !== undefined && record.revoked === undefined) {
          await options.mcpTokens.put({ ...record, revoked: { by: record.principalId, at: new Date(now()).toISOString() } });
          await revokeDelegation(record.principalId, record.delegationId);
        }
      }
    }
    return jsonResponse({});
  }

  async function authenticate(token: string): Promise<VerifiedPrincipal> {
    const at = new Date(now());
    // 1. Scoped personal bearer token (`edum_*`) minted in the Management UI.
    if (token.startsWith(MCP_BEARER_TOKEN_PREFIX)) {
      const record = await options.mcpTokens.findByDigest(await sha256Hex(token));
      if (
        record === undefined ||
        record.districtId !== options.districtId ||
        record.revoked !== undefined ||
        Date.parse(record.expiresAt) <= now()
      ) {
        throw unauthenticated();
      }
      const snapshot = await options.directory();
      const person = snapshot.principals.find((p) => p.id === record.principalId && p.districtId === options.districtId && p.status === "active");
      if (person === undefined) throw unauthenticated();
      const delegation = await options.delegations.get(record.delegationId);
      if (
        delegation === undefined ||
        delegation.districtId !== options.districtId ||
        delegation.grantorPrincipalId !== record.principalId ||
        !delegationInForce(delegation, at)
      ) {
        throw forbidden();
      }
      // Best-effort last-used timestamp update for the Management UI.
      await options.mcpTokens.touch(record.id, at.toISOString()).catch(() => undefined);
      return { districtId: options.districtId, principalId: record.principalId, delegationId: delegation.id };
    }

    // 2. Built-in OAuth 2.1 ES256 access JWT (`typ: at+jwt`).
    let jwtPayload: Record<string, unknown> | undefined;
    try {
      const key = await signingKey();
      const verified = await jwtVerify(token, key.publicKey, {
        issuer: origin,
        audience: resource,
        algorithms: ["ES256"],
        typ: "at+jwt",
        requiredClaims: ["sub", "iat", "exp", "client_id", "scope", "delegation_id"],
        currentDate: at,
        clockTolerance: CLOCK_SKEW_SECONDS,
      });
      jwtPayload = verified.payload as Record<string, unknown>;
    } catch {
      if (options.externalAuthenticator !== undefined) {
        return options.externalAuthenticator.authenticate(token);
      }
      throw unauthenticated();
    }

    const { sub, iat, exp, aud, scope, client_id: clientId, delegation_id: delegationId } = jwtPayload;
    const nowSeconds = now() / 1000;
    if (
      typeof sub !== "string" || sub === "" ||
      typeof iat !== "number" || typeof exp !== "number" ||
      iat > nowSeconds + CLOCK_SKEW_SECONDS || exp - iat > BUILTIN_ACCESS_TOKEN_SECONDS ||
      (Array.isArray(aud) && aud.length !== 1) ||
      typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId) ||
      typeof scope !== "string" ||
      !scope.split(" ").includes(MCP_SCOPE) ||
      typeof delegationId !== "string"
    ) {
      throw unauthenticated();
    }

    const snapshot = await options.directory();
    const person = snapshot.principals.find((p) => p.id === sub && p.districtId === options.districtId && p.status === "active");
    if (person === undefined) throw unauthenticated();

    const matching = (await options.delegations.list()).filter((delegation) =>
      delegation.districtId === options.districtId &&
      delegation.grantorPrincipalId === person.id &&
      delegation.client.issuer === origin &&
      delegation.client.clientId === clientId &&
      delegationInForce(delegation, at),
    );
    // The token names the delegation it was issued under; a re-consent's new delegation is not it.
    if (matching.length !== 1 || matching[0]!.id !== delegationId) throw forbidden();
    return { districtId: options.districtId, principalId: person.id, delegationId: matching[0]!.id };
  }

  return {
    authenticate,
    async listClients(): Promise<McpRegisteredClientView[]> {
      return await options.storage.listClients();
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.origin !== origin) return jsonResponse({ error: "forbidden" }, 403);
      if (request.method === "OPTIONS") {
        const reqOrigin = request.headers.get("origin");
        if (!reqOrigin || !options.allowedOrigins.includes(reqOrigin)) return jsonResponse({ error: "forbidden" }, 403);
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": reqOrigin,
            "access-control-allow-methods": "GET, POST",
            "access-control-allow-headers": "content-type, authorization",
            "vary": "Origin",
          },
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
        return applyCors(request, jsonResponse({
          issuer: origin,
          authorization_endpoint: `${origin}${BUILTIN_OAUTH_AUTHORIZE_PATH}`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
          revocation_endpoint: `${origin}/oauth/revoke`,
          jwks_uri: `${origin}/.well-known/jwks.json`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: [MCP_SCOPE],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
        }));
      }
      if (url.pathname === "/.well-known/jwks.json") {
        if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
        const key = await signingKey();
        return applyCors(request, jsonResponse({ keys: [key.publicJwk] }));
      }
      if (url.pathname === "/oauth/register") return applyCors(request, await handleRegister(request));
      if (url.pathname === "/oauth/token") return applyCors(request, await handleToken(request));
      if (url.pathname === "/oauth/revoke") return applyCors(request, await handleRevoke(request));
      if (url.pathname === BUILTIN_OAUTH_AUTHORIZE_PATH) {
        if (request.method === "GET") return await handleAuthorizeGet(request);
        if (request.method === "POST") return await handleAuthorizePost(request);
        return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
      }
      return jsonResponse({ error: "not_found" }, 404);
    },
  };
}
