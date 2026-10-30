import { z } from "zod";
import type { BlueprintReviewActor } from "./blueprint-review.ts";
import { BlueprintCatalogCommand, BlueprintRevisionConflict, PersistentBlueprintCatalog } from "./blueprint-storage.ts";

/** Host-only authentication seam: verify credentials and resolve current district directory roles per request. */
export type ResolveBlueprintRequestActor = (request: Request) => Promise<BlueprintReviewActor | undefined>;
const write = z.strictObject({ expectedRevision: z.number().int().nonnegative(), command: BlueprintCatalogCommand });
const download = BlueprintCatalogCommand.options[1].pick({ id: true, version: true });

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Authenticated district API mounted at /api/blueprints. The resolver is trusted host code,
 * never a request field. Host must provide CSRF-safe bearer authentication (no ambient cookies).
 * No caching: revocation is checked on every manifest download. There is no artifact byte endpoint.
 */
export function blueprintCatalogApi(catalog: PersistentBlueprintCatalog, resolveActor: ResolveBlueprintRequestActor,
  now: () => Date = () => new Date()): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/blueprints")) return json({ error: "not-found" }, 404);
    const actor = await resolveActor(request);
    if (!actor) return json({ error: "unauthenticated" }, 401);
    if (actor.principal.districtId !== catalog.districtId || actor.principal.status !== "active") return json({ error: "forbidden" }, 403);
    try {
      if (request.method === "GET" && path === "/api/blueprints") return json(catalog.entries(actor));
      if (request.method === "GET" && path === "/api/blueprints/audit") return json(catalog.audit(actor, now()));
      if (request.method === "GET" && path === "/api/blueprints/review") {
        const query = download.parse(Object.fromEntries(new URL(request.url).searchParams));
        return json(catalog.review(query.id, query.version, actor, now()));
      }
      if (request.method === "GET" && path === "/api/blueprints/download") {
        const query = download.parse(Object.fromEntries(new URL(request.url).searchParams));
        return json(catalog.download(query.id, query.version, actor));
      }
      if (request.method === "POST" && ["/api/blueprints/commands", "/api/blueprints/imports"].includes(path)) {
        // Bound before parsing even when Content-Length is absent or dishonest.
        const reader = request.body?.getReader();
        let text = "";
        let bytes = 0;
        const decoder = new TextDecoder();
        if (reader) {
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > 262144) { await reader.cancel(); return json({ error: "body-too-large" }, 413); }
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
          } finally { reader.releaseLock(); }
        }
        const body: unknown = JSON.parse(text);
        if (path.endsWith("/imports")) return json(catalog.importEntries(body, actor, now()));
        const input = write.parse(body);
        return json(catalog.execute(input.command, input.expectedRevision, actor, now()));
      }
      return json({ error: "not-found" }, 404);
    } catch (error) {
      if (error instanceof BlueprintRevisionConflict) return json({ error: "revision-conflict" }, 409);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "invalid-input" }, 400);
      // Keep internal metadata, audit contents and identity out of error responses.
      return json({ error: "catalog-request-denied" }, 403);
    }
  };
}
