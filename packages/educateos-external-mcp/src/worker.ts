import type { JWTVerifyGetKey } from "jose";
import { DurableObject } from "cloudflare:workers";
import { readMcpConfig } from "./discovery.ts";
import { DurableTokenStore } from "./token-store.ts";
import { startMcpDistrict } from "./runtime.ts";

/** Bind only this district's durable state. MCP_CONFIG is private deployment configuration. */
interface Env {
  MCP_CONFIG: string;
}

/** One district's directory, approvals, grants and atomic replay claims, owned by its account. */
export class McpDistrict extends DurableObject<Env> {
  #api: ReturnType<typeof startMcpDistrict> | undefined;

  /** Test seam; production always discovers configured issuer keys. */
  protected issuerKeys(): JWTVerifyGetKey | undefined { return undefined; }

  /** Serve the stateless MCP transport over durable district state. */
  override async fetch(request: Request): Promise<Response> {
    try {
      // Configuration is re-read on every deployment, never derived from a caller's claims.
      this.#api ??= startMcpDistrict(this.ctx.storage, new DurableTokenStore(this.ctx.storage), readMcpConfig(this.env.MCP_CONFIG), this.issuerKeys());
      return await (await this.#api).fetch(request);
    } catch {
      this.#api = undefined;
      return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const config = readMcpConfig(env.MCP_CONFIG);
      const url = new URL(request.url);
      if (url.origin !== config.origin) return new Response(null, { status: 403 });
      const origin = request.headers.get("origin");
      if (origin !== null && !config.allowedOrigins.includes(origin)) return new Response(null, { status: 403 });
      if (url.pathname === "/healthz") {
        return request.method === "GET"
          ? Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } })
          : new Response(null, { status: 405, headers: { allow: "GET" } });
      }
      // Public discovery must work even when the issuer is unavailable; it contains no school data.
      if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
        return Response.json({ resource: `${config.origin}/mcp`, authorization_servers: [config.issuer.issuer],
          scopes_supported: ["mcp:tools"], bearer_methods_supported: ["header"] }, { headers: {
          "cache-control": "no-store", "vary": "Origin", ...(origin ? { "access-control-allow-origin": origin } : {}),
        } });
      }
      if (url.pathname !== "/mcp" && url.pathname !== "/token") return new Response(null, { status: 404 });
      return await ctx.exports.McpDistrict.getByName(config.directory.district.id).fetch(request);
    } catch {
      return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  },
} satisfies ExportedHandler<Env>;
