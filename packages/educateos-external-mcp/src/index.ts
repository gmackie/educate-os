import { z } from "zod";
import type { DistrictId } from "@educateos/contracts";
import type { SchoolToolRunner } from "@educateos/policy";
import type { SchoolTokenAuthority } from "./auth.ts";
export * from "./auth.ts";

const VERSION = "2025-11-25";
const Envelope = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().finite()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const Initialize = z.strictObject({
  protocolVersion: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.strictObject({
    name: z.string(),
    version: z.string(),
    title: z.string().optional(),
  }),
});
const Call = z.strictObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
const Exchange = z.strictObject({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:token-exchange"),
  subject_token_type: z.literal("urn:ietf:params:oauth:token-type:jwt"),
  subject_token: z.string().min(1).max(16384),
});
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const rpcError = (id: string | number | null, code: number, message: string) =>
  json({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Standalone Fetch/Worker API. Supply the same district runner and durable approval queue as the
 * HTTP/LTI application. There is no MCP approval endpoint, and every write requires a person.
 * Supports the 2025-11-25 stateless Streamable HTTP JSON response profile, without SSE or sessions.
 */
export function createSchoolMcpApi(options: {
  districtId: DistrictId;
  runner: SchoolToolRunner;
  tokens: SchoolTokenAuthority;
  /** Exact browser origins allowed; absent Origin permits non-browser clients. */
  allowedOrigins: readonly string[];
}) {
  return {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path !== "/mcp" && path !== "/token") return json({ error: "not_found" }, 404);
      const origin = request.headers.get("origin");
      if (origin !== null && !options.allowedOrigins.includes(origin))
        return json({ error: "forbidden" }, 403);
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
        return json({ error: "unsupported_media_type" }, 415);
      // Bounded streaming read: Content-Length is untrusted and may be absent.
      let body: unknown;
      try {
        body = JSON.parse(await limitedBody(request));
      } catch {
        return rpcError(null, -32700, "Invalid JSON or oversized request");
      }
      if (path === "/token") {
        const parsed = Exchange.safeParse(body);
        if (!parsed.success) return json({ error: "invalid_request" }, 400);
        try {
          return json(await options.tokens.exchange(parsed.data.subject_token));
        } catch {
          return json({ error: "invalid_grant" }, 400);
        }
      }
      let principal;
      try {
        const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
        if (!bearer || bearer.length > 16384) throw new Error("Missing bearer");
        principal = await options.tokens.authenticate(bearer);
        if (principal.districtId !== options.districtId) throw new Error("Wrong district");
      } catch {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": "Bearer", "cache-control": "no-store" },
        });
      }
      const accept = request.headers.get("accept") ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
        return json({ error: "not_acceptable" }, 406);
      const parsed = Envelope.safeParse(body);
      if (!parsed.success) return rpcError(null, -32600, "Invalid request");
      const { id, method, params } = parsed.data;
      if (method !== "initialize" && request.headers.get("mcp-protocol-version") !== VERSION)
        return json({ error: "unsupported_protocol_version" }, 400);
      if (id === undefined) {
        if (
          method === "notifications/initialized" &&
          z.strictObject({}).safeParse(params ?? {}).success
        )
          return new Response(null, { status: 202 });
        // Notifications must never execute calls or emit JSON-RPC responses.
        return new Response(null, { status: 202 });
      }
      let result: unknown;
      if (method === "initialize") {
        if (!Initialize.safeParse(params).success)
          return rpcError(id, -32602, "Invalid parameters");
        result = {
          protocolVersion: VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "educateos-school-tools", version: "0.1.0" },
        };
      } else if (method === "tools/list") {
        if (!z.strictObject({}).safeParse(params ?? {}).success)
          return rpcError(id, -32602, "Invalid parameters");
        result = { tools: options.runner.list() };
      } else if (method === "tools/call") {
        const call = Call.safeParse(params);
        if (!call.success) return rpcError(id, -32602, "Invalid parameters");
        try {
          const outcome = await options.runner.invoke(
            { principal, channel: "mcp-tool" },
            call.data.name,
            call.data.arguments,
            { confirmWrites: true },
          );
          result = {
            content: [{ type: "text", text: JSON.stringify(outcome) }],
            isError: outcome.status === "error",
          };
        } catch {
          return rpcError(id, -32603, "Tool service unavailable");
        }
      } else if (method === "ping") {
        if (!z.strictObject({}).safeParse(params ?? {}).success)
          return rpcError(id, -32602, "Invalid parameters");
        result = {};
      } else return rpcError(id, -32601, "Method not found");
      return json({ jsonrpc: "2.0", id, result });
    },
  };
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
      if (length > 65536) throw new Error("Body too large");
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export * from "./token-store.ts";
