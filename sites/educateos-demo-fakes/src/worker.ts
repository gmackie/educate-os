// The public provider-fakes Worker of the EducateOS demo districts (SCHO-210), at
// fakes.demo.educateos.io. It serves:
//
// - `/healthz`: liveness. Reads nothing.
// - `/`: the districts and the base URL of each of their fakes. No credentials.
// - `/<slug>/<vendor>/…`: a district's fake (see layout.ts), through the district's object.
// - `/_admin/<slug>/…`: the operator's surface, behind Cloudflare Access, whose assertion the
//   Worker verifies again (access.ts).
//
// Anything else, and any district or fake a profile does not use, is a 404. Request bodies are
// capped before they reach a fake; the per-IP rate limit is in the district's object. README.md
// describes the whole surface.
import type { JWTVerifyGetKey } from "jose";
import { verifyAdminAssertion } from "./access.ts";
import { clientKeyOf, redirectUrisProblem } from "./config.ts";
import type { DemoFakesDistrict } from "./district.ts";
import { publicOrigin, type Env } from "./env.ts";
import { districtOf, publicIndex, publicTarget } from "./layout.ts";

export { DemoFakesDistrict } from "./district.ts";

/** The largest request body served: 64 KiB, plenty for any token, registration or score request. */
export const MAX_BODY_BYTES = 64 * 1024;

/** What the Worker reaches its district objects through. */
interface Exports {
  readonly DemoFakesDistrict: DurableObjectNamespace<DemoFakesDistrict>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/**
 * The request with its body read, or a 413 when the body is over {@link MAX_BODY_BYTES}. A declared
 * length over the cap is refused unread; an undeclared one is read only up to the cap.
 */
async function capped(request: Request): Promise<Request | Response> {
  if (request.body === null) return request;
  const tooLarge = () => json({ error: "request_too_large", error_description: `Bodies are limited to ${MAX_BODY_BYTES} bytes.` }, 413);
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return new Request(request, { method: request.method, body });
}

/** What {@link createWorker} may replace. */
export interface WorkerOptions {
  /** The keys Access assertions are verified with. Defaults to the team's published certs. */
  readonly accessKeys?: JWTVerifyGetKey;
}

/** The Worker's fetch handler. The tests make one that trusts a local Access key. */
export function createWorker(options: WorkerOptions = {}): ExportedHandler<Env> {
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;
      if (pathname === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
      if (pathname === "/" && request.method === "GET") return json({ service: "educateos-demo-fakes", ...publicIndex(publicOrigin(env)) });
      const exports = (ctx as unknown as { exports: Exports }).exports;
      // A refused OIDC_REDIRECT_URIS (a Cloudflare Access callback above all) serves no fake and no
      // admin request until it is fixed.
      const problem = redirectUrisProblem(env);
      if (problem !== undefined) {
        console.error(JSON.stringify({ event: "config.refused", problem }));
        return json({ error: "misconfigured", error_description: "The Worker's OIDC_REDIRECT_URIS is refused; see its logs." }, 503);
      }

      if (pathname === "/_admin" || pathname.startsWith("/_admin/")) {
        // Everything admin is refused unless the Access application's audience is configured and
        // the request carries an assertion for it.
        if (env.ADMIN_ACCESS_AUD === undefined || env.ADMIN_ACCESS_AUD.trim() === "") return json({ error: "forbidden", error_description: "The admin surface is not configured." }, 403);
        if ((await verifyAdminAssertion(request, env.ADMIN_ACCESS_AUD, options.accessKeys)) === null) return json({ error: "forbidden" }, 403);
        const district = districtOf(pathname.split("/")[2] ?? "");
        if (district === undefined) return json({ error: "not_found" }, 404);
        const body = await capped(request);
        if (body instanceof Response) return body;
        return exports.DemoFakesDistrict.getByName(district.slug).admin(district.slug, body);
      }

      const target = publicTarget(pathname);
      if (target === undefined) return json({ error: "not_found" }, 404);
      const body = await capped(request);
      if (body instanceof Response) return body;
      // Cloudflare sets CF-Connecting-IP on every request it proxies, replacing any the client sent.
      // IPv6 callers count by /64.
      const client = clientKeyOf(request.headers.get("cf-connecting-ip"));
      return exports.DemoFakesDistrict.getByName(target.district.slug).serve(target.district.slug, body, client);
    },
  };
}

export default createWorker();
