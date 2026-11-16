// Live checks over plain HTTPS, with no credentials: what an MCP client would see first.
//
// - The district's `/mcp`: its RFC 9728 protected-resource metadata, and the 401 challenge an
//   unauthenticated request gets.
// - An authorization server's RFC 8414 (or OpenID) metadata: whether a client can register and
//   sign in there.
// - An external MCP server, before an administrator adds it to the Workshop: whether it answers
//   without sign-in, or which authorization server it names.
//
// Nothing here sends a token, a cookie or anything from the answers file but a hostname. Redirects
// are never followed: a redirect to `<team>.cloudflareaccess.com` is the answer (Cloudflare Access
// sits in front of the path), not a hop to take. Bodies are read up to 64 KiB.
import { isBlockedHost } from "@gadgets/mcp-shared/endpoint";

/** How long one request may take. */
export const PROBE_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

/** The MCP protocol revision the Workshop's MCP connector speaks (the pinned client's). */
const PROBE_PROTOCOL_VERSION = "2025-06-18";

/** One HTTP answer, as far as the checks need it. */
interface Answer {
  status: number;
  location: string | undefined;
  wwwAuthenticate: string | undefined;
  contentType: string;
  json: unknown;
}

/** A request that did not get an HTTP answer. */
export class ProbeUnreachable extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`no answer from ${url}`);
    this.url = url;
    this.name = "ProbeUnreachable";
  }
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<Answer> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    throw new ProbeUnreachable(url);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const text = await readBounded(response).catch(() => "");
  let json: unknown;
  if (/json/i.test(contentType)) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return {
    status: response.status,
    location: response.headers.get("location") ?? undefined,
    wwwAuthenticate: response.headers.get("www-authenticate") ?? undefined,
    contentType,
    json,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Whether `location` sends the client to a Cloudflare Access sign-in. */
export function isAccessRedirect(location: string | undefined): boolean {
  if (location === undefined) return false;
  try {
    const url = new URL(location);
    return url.hostname.endsWith(".cloudflareaccess.com") || url.pathname.startsWith("/cdn-cgi/access/");
  } catch {
    return location.startsWith("/cdn-cgi/access/");
  }
}

/** The `resource_metadata` URL in a `WWW-Authenticate: Bearer ...` challenge (RFC 9728 §5.1). */
export function resourceMetadataUrl(challenge: string | undefined): string | undefined {
  return challenge === undefined ? undefined : /resource_metadata="([^"]+)"/i.exec(challenge)?.[1];
}

/** RFC 9728 metadata, as far as the checks read it. */
export interface ResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopes: string[];
}

function resourceMetadata(json: unknown): ResourceMetadata | undefined {
  if (!isRecord(json) || typeof json.resource !== "string") return undefined;
  return { resource: json.resource, authorizationServers: strings(json.authorization_servers), scopes: strings(json.scopes_supported) };
}

/** What the district's `/mcp` looks like from outside. */
export type EndpointProbe =
  | { state: "on"; metadata: ResourceMetadata; challenge: "ok" | "missing" | "unexpected"; challengeStatus: number }
  | { state: "off" }
  | { state: "access"; status: number }
  | { state: "unexpected"; status: number }
  | { state: "unreachable" };

/** The district's MCP endpoint at `resource` (`<origin>/mcp`), probed without credentials. */
export async function probeDistrictEndpoint(fetchImpl: typeof fetch, resource: string): Promise<EndpointProbe> {
  const url = new URL(resource);
  const metadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  let answer: Answer;
  try {
    answer = await request(fetchImpl, metadataUrl, { headers: { accept: "application/json" } });
  } catch {
    return { state: "unreachable" };
  }
  if (answer.status >= 300 && answer.status < 400 && isAccessRedirect(answer.location)) return { state: "access", status: answer.status };
  if (answer.status === 404) return { state: "off" };
  const metadata = answer.status === 200 ? resourceMetadata(answer.json) : undefined;
  if (metadata === undefined) return { state: "unexpected", status: answer.status };

  // An unauthenticated MCP request: a resource server answers 401 and names its metadata.
  let challenge: Answer;
  try {
    challenge = await request(fetchImpl, resource, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  } catch {
    return { state: "on", metadata, challenge: "unexpected", challengeStatus: 0 };
  }
  const named = resourceMetadataUrl(challenge.wwwAuthenticate);
  const verdict = challenge.status === 401 ? (named === undefined ? "missing" : "ok") : "unexpected";
  return { state: "on", metadata, challenge: verdict, challengeStatus: challenge.status };
}

/** An authorization server's metadata, as far as an MCP client needs it. */
export interface AuthorizationServerProbe {
  /** Where the metadata was found, or undefined when it wasn't. */
  metadataUrl: string | undefined;
  /** Whether its `issuer` is exactly the one asked for (RFC 8414 §3.3). */
  issuerMatches: boolean;
  authorizationEndpoint: boolean;
  tokenEndpoint: boolean;
  /** Dynamic client registration (RFC 7591). */
  registration: boolean;
  /** Client ID Metadata Documents. */
  clientIdMetadataDocuments: boolean;
  /** PKCE with S256. */
  pkceS256: boolean;
}

/** The RFC 8414 well-known URLs for `issuer`, then OpenID Connect's. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    ...(path ? [`${url.origin}${path}/.well-known/openid-configuration`] : []),
  ];
}

/** Reads `issuer`'s metadata. Undefined fields read as unsupported. */
export async function probeAuthorizationServer(fetchImpl: typeof fetch, issuer: string): Promise<AuthorizationServerProbe> {
  for (const candidate of authorizationServerMetadataUrls(issuer)) {
    const answer = await request(fetchImpl, candidate, { headers: { accept: "application/json" } }).catch(() => undefined);
    if (answer?.status !== 200 || !isRecord(answer.json)) continue;
    const json = answer.json;
    return {
      metadataUrl: candidate,
      issuerMatches: json.issuer === issuer,
      authorizationEndpoint: typeof json.authorization_endpoint === "string",
      tokenEndpoint: typeof json.token_endpoint === "string",
      registration: typeof json.registration_endpoint === "string",
      clientIdMetadataDocuments: json.client_id_metadata_document_supported === true,
      pkceS256: strings(json.code_challenge_methods_supported).includes("S256"),
    };
  }
  return {
    metadataUrl: undefined, issuerMatches: false, authorizationEndpoint: false, tokenEndpoint: false,
    registration: false, clientIdMetadataDocuments: false, pkceS256: false,
  };
}

/** Why the Workshop's MCP connector would refuse an address before connecting, or undefined. */
export function endpointProblem(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return "that is not a URL";
  }
  if (url.protocol !== "https:") return "the Workshop connects to https:// MCP servers only";
  if (isBlockedHost(url.hostname)) return "the Workshop refuses private, loopback and metadata hosts";
  if (url.username || url.password) return "remove the username and password from the URL";
  return undefined;
}

/** What an external MCP server looks like to the Workshop's connector, before it signs in. */
export type ServerProbe =
  | { state: "public"; status: number; serverName: string | undefined }
  | { state: "oauth"; metadataUrl: string | undefined; resource: ResourceMetadata | undefined; authorizationServer: (AuthorizationServerProbe & { issuer: string }) | undefined }
  | { state: "access" }
  | { state: "redirect"; status: number }
  | { state: "unexpected"; status: number }
  | { state: "unreachable" };

/**
 * Starts an MCP session with `endpoint` the way the Workshop's connector does (`initialize`, no
 * credentials) and follows a 401 through RFC 9728 to the authorization server's metadata.
 */
export async function probeMcpServer(fetchImpl: typeof fetch, endpoint: string, clientVersion: string): Promise<ServerProbe> {
  let answer: Answer;
  try {
    answer = await request(fetchImpl, endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: PROBE_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "launch-educate-os", version: clientVersion } },
      }),
    });
  } catch {
    return { state: "unreachable" };
  }
  if (answer.status >= 300 && answer.status < 400) {
    return isAccessRedirect(answer.location) ? { state: "access" } : { state: "redirect", status: answer.status };
  }
  if (answer.status === 200) {
    const result = isRecord(answer.json) && isRecord(answer.json.result) ? answer.json.result : undefined;
    const info = result && isRecord(result.serverInfo) ? result.serverInfo : undefined;
    return { state: "public", status: 200, serverName: typeof info?.name === "string" ? info.name : undefined };
  }
  if (answer.status !== 401) return { state: "unexpected", status: answer.status };

  // RFC 9728: the challenge names the metadata; without it, the well-known path for the endpoint.
  const url = new URL(endpoint);
  const metadataUrl = resourceMetadataUrl(answer.wwwAuthenticate)
    ?? `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`;
  if (endpointProblem(metadataUrl) !== undefined) return { state: "oauth", metadataUrl: undefined, resource: undefined, authorizationServer: undefined };
  const metadataAnswer = await request(fetchImpl, metadataUrl, { headers: { accept: "application/json" } }).catch(() => undefined);
  const resource = metadataAnswer?.status === 200 ? resourceMetadata(metadataAnswer.json) : undefined;
  const issuer = resource?.authorizationServers[0];
  if (issuer === undefined || endpointProblem(issuer) !== undefined) return { state: "oauth", metadataUrl, resource, authorizationServer: undefined };
  return { state: "oauth", metadataUrl, resource, authorizationServer: { issuer, ...await probeAuthorizationServer(fetchImpl, issuer) } };
}
