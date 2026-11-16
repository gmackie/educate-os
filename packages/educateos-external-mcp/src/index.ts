import { z } from "zod";
import {
  createMcpHandler,
  isLegacyRequest,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type ListToolsResult,
} from "@modelcontextprotocol/server";
import { EducateOsError, type DistrictId, type VerifiedPrincipal } from "@educateos/contracts";
import type { SchoolToolRunner } from "@educateos/policy";
export * from "./auth.ts";

/** The protocol revisions served: 2026-07-28 (modern, stateless), and 2025-11-25 as the legacy profile. */
export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25"] as const;
const MAX_BODY_BYTES = 65536;
const Call = z.strictObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
const Exchange = z.strictObject({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:token-exchange"),
  subject_token_type: z.literal("urn:ietf:params:oauth:token-type:jwt"),
  subject_token: z.string().min(1).max(16384),
});
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * What the transport needs to know who a bearer token acts for: `SchoolTokenAuthority`, or a
 * protected-resource authority such as `DelegatedResourceAuthority`. `authenticate` throws to
 * refuse: an `EducateOsError` with code `forbidden` is answered 403, anything else 401.
 */
export interface McpAuthenticator {
  /** The verified subject the token acts for, delegation included. */
  authenticate(token: string): Promise<VerifiedPrincipal>;
  /** The narrow JSON token exchange behind POST `/token`; absent, `/token` is not served. */
  exchange?(assertion: string): Promise<unknown>;
}

/**
 * Standalone Fetch/Worker API. Supply the same district runner and durable approval queue as the
 * HTTP/LTI application. There is no MCP approval endpoint, and every write requires a person.
 *
 * Serves MCP 2026-07-28 statelessly (`server/discover`, the `Mcp-Method`/`Mcp-Name` headers and
 * the per-request `_meta` envelope) and 2025-11-25 as the legacy stateless profile, through the
 * pinned official SDK. The bearer token is authenticated before the SDK reads the body, on every
 * request, listings included: a listing's cache hint is `ttlMs: 0` and `cacheScope: private`, and
 * no cached listing stands in for authorization.
 */
export function createSchoolMcpApi(options: {
  districtId: DistrictId;
  runner: SchoolToolRunner;
  tokens: McpAuthenticator;
  /** Exact browser origins allowed; absent Origin permits non-browser clients. */
  allowedOrigins: readonly string[];
  /** Canonical public origin and trusted authorization servers for RFC 9728 discovery. */
  resource?: { origin: string; authorizationServers: readonly string[]; scopes: readonly string[] };
}) {
  /** One request's server, acting for the subject the bearer token was verified as. */
  function serverFor(principal: VerifiedPrincipal): Server {
    const server = new Server(
      { name: "educateos-school-tools", version: "0.2.0" },
      {
        capabilities: { tools: {} },
        supportedProtocolVersions: [...MCP_PROTOCOL_VERSIONS],
        // A listing is private to its caller and never cached: each request is authorized again.
        cacheHints: { "tools/list": { ttlMs: 0, cacheScope: "private" } },
      },
    );
    server.setRequestHandler("tools/list", () => ({ tools: options.runner.list() }) as ListToolsResult);
    server.setRequestHandler("tools/call", async (request) => {
      const call = Call.safeParse(request.params);
      if (!call.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid parameters");
      let outcome;
      try {
        outcome = await options.runner.invoke(
          { principal, channel: "mcp-tool" },
          call.data.name,
          call.data.arguments,
          { confirmWrites: true },
        );
      } catch {
        throw new ProtocolError(ProtocolErrorCode.InternalError, "Tool service unavailable");
      }
      return { content: [{ type: "text", text: JSON.stringify(outcome) }], isError: outcome.status === "error" };
    });
    return server;
  }
  const principalOf = (authInfo: AuthInfo | undefined): VerifiedPrincipal => {
    const principal = (authInfo?.extra as { principal?: VerifiedPrincipal } | undefined)?.principal;
    if (principal === undefined) throw new Error("Unauthenticated MCP request");
    return principal;
  };
  const modern = createMcpHandler(({ authInfo }) => serverFor(principalOf(authInfo)), {
    legacy: "reject",
    responseMode: "json",
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  /** The 2025-11-25 profile: one stateless exchange per request, answered as JSON rather than SSE. */
  async function legacy(request: Request, authInfo: AuthInfo): Promise<Response> {
    const server = serverFor(principalOf(authInfo));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, { authInfo });
    } finally {
      await server.close();
    }
  }
  return {
    async fetch(request: Request): Promise<Response> {
      const response = await serve(request);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("x-content-type-options", "nosniff");
      headers.set("vary", "Origin");
      const origin = request.headers.get("origin");
      if (origin && options.allowedOrigins.includes(origin)) {
        headers.set("access-control-allow-origin", origin);
        headers.set("access-control-expose-headers", "WWW-Authenticate, MCP-Protocol-Version");
      }
      return new Response(response.body, { status: response.status, headers });
    },
  };
  async function serve(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (options.resource && new URL(request.url).origin !== options.resource.origin)
        return json({ error: "forbidden" }, 403);
      const origin = request.headers.get("origin");
      if (origin !== null && !options.allowedOrigins.includes(origin))
        return json({ error: "forbidden" }, 403);
      if (options.resource && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
        if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
        return json({ resource: `${options.resource.origin}/mcp`, authorization_servers: options.resource.authorizationServers,
          scopes_supported: options.resource.scopes, bearer_methods_supported: ["header"] });
      }
      if (path !== "/mcp" && (path !== "/token" || options.tokens.exchange === undefined)) return json({ error: "not_found" }, 404);
      if (request.method === "OPTIONS" && origin !== null) {
        const requested = (request.headers.get("access-control-request-headers") ?? "").toLowerCase().split(",").map((v) => v.trim()).filter(Boolean);
        const allowed = ["authorization", "content-type", "mcp-protocol-version", "mcp-method", "mcp-name"];
        if (request.headers.get("access-control-request-method") !== "POST" || requested.some((h) => !allowed.includes(h)))
          return json({ error: "forbidden" }, 403);
        return new Response(null, { status: 204, headers: {
          "access-control-allow-methods": "POST", "access-control-allow-headers": allowed.join(", "),
        } });
      }
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
        return json({ error: "unsupported_media_type" }, 415);
      if (path === "/token") {
        // Bounded streaming read: Content-Length is untrusted and may be absent.
        let body: unknown;
        try {
          body = JSON.parse(await limitedBody(request));
        } catch {
          return json({ error: "invalid_request" }, 400);
        }
        const parsed = Exchange.safeParse(body);
        if (!parsed.success) return json({ error: "invalid_request" }, 400);
        try {
          return json(await options.tokens.exchange!(parsed.data.subject_token));
        } catch {
          return json({ error: "invalid_grant" }, 400);
        }
      }
      let principal: VerifiedPrincipal;
      try {
        const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
        if (!bearer || bearer.length > 16384) throw new Error("Missing bearer");
        principal = await options.tokens.authenticate(bearer);
        if (principal.districtId !== options.districtId) throw new Error("Wrong district");
      } catch (error) {
        // A good token whose client may not act here: 403, so the client does not loop on sign-in.
        if (error instanceof EducateOsError && error.code === "forbidden") return json({ error: "forbidden" }, 403);
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": options.resource
            ? `Bearer resource_metadata="${options.resource.origin}/.well-known/oauth-protected-resource/mcp", scope="${options.resource.scopes.join(" ")}"`
            : "Bearer", "cache-control": "no-store" },
        });
      }
      // The SDK never derives authInfo from headers: it carries only the subject verified above.
      const authInfo: AuthInfo = { token: "", clientId: "", scopes: [], extra: { principal } };
      return (await isLegacyRequest(request, undefined, { maxRequestBodySize: MAX_BODY_BYTES }))
        ? legacy(request, authInfo)
        : modern.fetch(request, { authInfo });
  }
}

async function limitedBody(request: Request): Promise<string> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error("Body too large");
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export * from "./token-store.ts";
