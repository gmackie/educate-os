// Drives a district's organization MCP endpoint in production the way an outside AI client does
// (docs/educateos/mcp-validation): the built-in OAuth 2.1 flow (discovery, dynamic client
// registration, Access-gated consent, PKCE S256), then MCP calls, Management UI approvals, refresh
// rotation and refresh-replay revocation. It acts as a real staff member, so use the agents.gmac.io
// test identities (agent-inbox's access-sign-in.ts prints their CF_Authorization cookie).
//
//   ORIGIN=https://northfield.educateos.io CF_COOKIE=<cookie> OUT_DIR=/tmp/mcp-run \
//     node scripts/demo/mcp-production-demo.ts connect "<class label substring>" [read-write|read-only]
//   node scripts/demo/mcp-production-demo.ts list [tool ...] | call <tool> '<json>' | approve <id> <digest>
//     | decline <id> | overview | approvals | refresh | replay
//
// Session tokens live in $OUT_DIR/state-<host>.json (mode 0600); delete it after the run. Evidence
// lines append to $OUT_DIR/evidence-<host>.jsonl with every token redacted. `replay` revokes the
// connection's delegation by design, so run it last.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const ORIGIN = process.env.ORIGIN!;
const COOKIE = process.env.CF_COOKIE ?? "";
const host = new URL(ORIGIN).host;
const OUT_DIR = process.env.OUT_DIR ?? ".";
const STATE = `${OUT_DIR}/state-${host}.json`;
const EVIDENCE = `${OUT_DIR}/evidence-${host}.jsonl`;
const REDIRECT = "http://127.0.0.1:8765/callback";

type State = { clientId?: string; access?: string; refresh?: string; oldRefresh?: string };
const load = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s: State) => { writeFileSync(STATE, JSON.stringify(s)); chmodSync(STATE, 0o600); };
const redact = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" ? x.replace(/\b(edu[amr]_[0-9a-f]{8})[0-9a-f]+/g, "$1…").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>") : x)));
function record(step: string, data: unknown) {
  const line = { at: new Date().toISOString(), origin: ORIGIN, step, data: redact(data) };
  appendFileSync(EVIDENCE, JSON.stringify(line) + "\n");
  console.log(JSON.stringify(line, null, 2));
}
const b64url = (b: Buffer) => b.toString("base64url");
const withCookie = (h: Record<string, string> = {}) => (COOKIE ? { ...h, cookie: `CF_Authorization=${COOKIE}` } : h);

async function rpc(method: string, params: unknown, token = load().access!) {
  const res = await fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* SSE or empty */ }
  return { status: res.status, wwwAuthenticate: res.headers.get("www-authenticate"), body };
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "connect") {
  const [scopeMatch = "", access = "read-write"] = args;
  const prm = await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json();
  const asm = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json() as Record<string, string>;
  const unauth = await fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  record("discovery", { protectedResource: prm, authorizationServer: asm, unauthenticatedMcp: { status: unauth.status, wwwAuthenticate: unauth.headers.get("www-authenticate") } });
  const reg = await (await fetch(asm.registration_endpoint!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "EducateOS production demo (Claude Code)", redirect_uris: [REDIRECT] }) })).json() as { client_id: string };
  record("dynamic-client-registration", reg);
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const auth = new URL(asm.authorization_endpoint!);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: `${ORIGIN}/mcp`, scope: "mcp:tools", state })) auth.searchParams.set(k, v);
  const noCookie = await fetch(auth, { redirect: "manual" });
  record("authorize-without-access-session", { status: noCookie.status, location: noCookie.headers.get("location")?.replace(/\?.*/, "?…") });
  const consent = await fetch(auth, { headers: withCookie(), redirect: "manual" });
  const html = await consent.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
  const options = [...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => ({ id: m[1]!, label: m[2]! })).filter((o) => /:/.test(o.id));
  record("consent-screen", { status: consent.status, heading: /<h1>([^<]+)/.exec(html)?.[1], shows: [...html.matchAll(/<strong>([^<]+):<\/strong>\s*(?:<span[^>]*>)?([^<]+)/g)].map((m) => `${m[1]}: ${m[2]}`), scopeOptions: options });
  if (!nonce) throw new Error(`no consent nonce (status ${consent.status})`);
  const chosen = options.find((o) => o.label.toLowerCase().includes(scopeMatch.toLowerCase())) ?? options[0]!;
  const approve = await fetch(`${ORIGIN}/oauth/authorize`, { method: "POST", redirect: "manual", headers: withCookie({ "content-type": "application/x-www-form-urlencoded" }), body: new URLSearchParams({ nonce, scopeId: chosen.id, access, durationHours: "24", decision: "approve" }) });
  const location = new URL(approve.headers.get("location")!);
  record("consent-approved", { status: approve.status, scope: chosen, access, redirectedTo: `${location.origin}${location.pathname}`, stateMatches: location.searchParams.get("state") === state, iss: location.searchParams.get("iss") });
  const tok = await (await fetch(asm.token_endpoint!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code")!, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${ORIGIN}/mcp` }) })).json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
  const claims = JSON.parse(Buffer.from(tok.access_token.split(".")[1]!, "base64url").toString());
  record("token-exchange", { token_type: "Bearer", expires_in: tok.expires_in, scope: tok.scope, refresh: tok.refresh_token, accessClaims: claims });
  save({ clientId: reg.client_id, access: tok.access_token, refresh: tok.refresh_token });
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "educateos-demo", version: "1" } });
  record("mcp-initialize", init);
} else if (cmd === "list") {
  const r = await rpc("tools/list", {});
  const tools = (r.body as { result: { tools: { name: string; annotations?: unknown; inputSchema?: unknown }[] } }).result.tools;
  record("tools-list", { status: r.status, count: tools.length, names: tools.map((t) => t.name) });
  if (args[0]) console.log(JSON.stringify(tools.filter((t) => args.includes(t.name)), null, 2));
} else if (cmd === "call") {
  const r = await rpc("tools/call", { name: args[0], arguments: JSON.parse(args[1] ?? "{}") });
  const content = (r.body as { result?: { content?: { text: string }[]; isError?: boolean } }).result;
  let parsed: unknown = content;
  try { parsed = JSON.parse(content!.content![0]!.text); } catch { /* keep raw */ }
  record(`tool:${args[0]}`, { args: JSON.parse(args[1] ?? "{}"), httpStatus: r.status, isError: content?.isError, result: parsed ?? r.body });
} else if (cmd === "approve" || cmd === "decline") {
  const [id, digest] = args;
  const res = await fetch(`${ORIGIN}/api/teacher/tool-approvals/${id}/${cmd}`, { method: "POST", headers: withCookie({ "content-type": "application/json" }), body: JSON.stringify(cmd === "approve" ? { digest } : { reason: "not-needed" }) });
  record(`management-ui-${cmd}`, { approvalId: id, status: res.status, body: await res.json().catch(() => null) });
} else if (cmd === "overview" || cmd === "approvals") {
  const path = cmd === "overview" ? "/api/teacher/mcp" : "/api/teacher/tool-approvals";
  const res = await fetch(`${ORIGIN}${path}`, { headers: withCookie() });
  record(`management-ui-${cmd}`, { status: res.status, body: await res.json().catch(() => null) });
} else if (cmd === "refresh") {
  const s = load();
  const res = await fetch(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refresh!, client_id: s.clientId! }) });
  const tok = await res.json() as { access_token: string; refresh_token: string };
  record("refresh-rotation", { status: res.status, rotated: tok.refresh_token !== s.refresh });
  save({ ...s, access: tok.access_token, refresh: tok.refresh_token, oldRefresh: s.refresh });
} else if (cmd === "replay") {
  const s = load();
  const res = await fetch(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.oldRefresh!, client_id: s.clientId! }) });
  const after = await rpc("tools/list", {});
  record("refresh-replay-detected", { replayStatus: res.status, replayBody: await res.json(), mcpAfterReplay: { status: after.status } });
} else {
  console.error("unknown command");
  process.exit(2);
}
