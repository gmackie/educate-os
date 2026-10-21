import { type ErrorCode, Scope, SchoolOsError, type VerifiedPrincipal } from "@schoolos/contracts";
import type { ContentStudio } from "./service.ts";

/**
 * Resolves the verified principal behind a request, from trusted server-side identity such as a
 * verified Cloudflare Access token (F04). Returns undefined when the request is not authenticated.
 * Nothing in the request body or query can name the subject.
 */
export type ResolveSubject = (request: Request) => Promise<VerifiedPrincipal | undefined>;

/** The HTTP status each error code is returned with. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  "validation-failed": 400,
  "policy-violation": 422,
  "budget-exceeded": 429,
  unavailable: 503,
};

/** The largest JSON request body accepted, in bytes. Uploads have their own cap. */
const MAX_JSON_BYTES = 64 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new SchoolOsError("validation-failed", "the request body is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new SchoolOsError("validation-failed", "the request body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new SchoolOsError("validation-failed", "the request body is not JSON");
  }
}

/** A scope from the `scope` query parameter, which holds the scope as JSON. */
function scopeParam(url: URL): Scope {
  const raw = url.searchParams.get("scope");
  let value: unknown;
  try {
    value = raw === null ? undefined : JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const parsed = Scope.safeParse(value);
  if (!parsed.success) throw new SchoolOsError("validation-failed", "scope: expected a scope as JSON");
  return parsed.data;
}

async function readUpload(request: Request, maxBytes: number) {
  const declared = Number(request.headers.get("content-length"));
  // Multipart framing adds a little; anything far beyond the cap is refused before it is read.
  if (Number.isFinite(declared) && declared > maxBytes + MAX_JSON_BYTES) throw new SchoolOsError("policy-violation", "the upload is too large");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new SchoolOsError("validation-failed", "expected a multipart form");
  }
  const file = form.get("file");
  const metadata = form.get("metadata");
  if (typeof file === "string" || file === null || typeof metadata !== "string") {
    throw new SchoolOsError("validation-failed", "expected a `file` part and a `metadata` JSON part");
  }
  let description: unknown;
  try {
    description = JSON.parse(metadata);
  } catch {
    throw new SchoolOsError("validation-failed", "metadata: expected JSON");
  }
  return { description, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/**
 * The Content Studio's HTTP API, as a fetch-standard handler. It is a thin layer over
 * {@link ContentStudio}, so HTTP calls are authorized exactly as direct calls are. Paths are
 * relative to wherever the handler is mounted:
 *
 * - `POST /imports/url`: `{ url, targetScope, updatesResourceId? }`
 * - `POST /imports/blueprint`: `{ release, targetScope, updatesResourceId? }` (a Blueprint release)
 * - `POST /imports/upload`: multipart with a `file` part and a `metadata` part holding
 *   `{ fileName, mediaType, targetScope, updatesResourceId? }` as JSON
 * - `GET /queue?scope=<scope JSON>`
 * - `GET /items/<id>/report`, `GET /items/<id>/audit`
 * - `POST /items/<id>/rights`: `{ mode, reason }`
 * - `POST /items/<id>/approve`: `{ alignments }`
 * - `POST /items/<id>/reject`: `{ reason }`
 * - `POST /items/<id>/publish`
 * - `GET /releases?scope=<scope JSON>&resourceId=<id>`
 * - `POST /bindings`: `{ resourceId, version?, offering }`
 *
 * Errors are returned as a `SchoolOsErrorBody`. Unexpected failures return a generic 500 and
 * never their message.
 */
export function createContentStudioHandler(options: {
  studio: ContentStudio;
  resolveSubject: ResolveSubject;
  /** The largest upload accepted, in bytes. Should match the studio's own cap. */
  maxUploadBytes?: number;
}): (request: Request) => Promise<Response> {
  const { studio, resolveSubject } = options;
  const maxUploadBytes = options.maxUploadBytes ?? 20 * 1024 * 1024;

  async function route(request: Request, subject: VerifiedPrincipal): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method;
    if (method === "POST" && path === "/imports/url") return json(await studio.submitUrl(subject, await readJson(request)), 201);
    if (method === "POST" && path === "/imports/blueprint") {
      // A release carries its files, so it may be as large as an upload.
      return json(await studio.submitBlueprint(subject, await readJson(request, maxUploadBytes + MAX_JSON_BYTES)), 201);
    }
    if (method === "POST" && path === "/imports/upload") {
      const { description, bytes } = await readUpload(request, maxUploadBytes);
      return json(await studio.submitUpload(subject, description, bytes), 201);
    }
    if (method === "GET" && path === "/queue") return json(await studio.listQueue(subject, scopeParam(url)));
    if (method === "GET" && path === "/releases") {
      return json(await studio.listReleases(subject, scopeParam(url), url.searchParams.get("resourceId") ?? undefined));
    }
    if (method === "POST" && path === "/bindings") return json(await studio.bindToOffering(subject, await readJson(request)), 201);
    const item = /^\/items\/([^/]+)\/([a-z]+)$/.exec(path);
    if (item !== null) {
      const id = item[1]!;
      const operation = item[2]!;
      if (method === "GET" && operation === "report") return json(await studio.getReport(subject, id));
      if (method === "GET" && operation === "audit") return json(await studio.listAudit(subject, id));
      if (method === "POST" && operation === "rights") return json(await studio.setRightsMode(subject, id, await readJson(request)));
      if (method === "POST" && operation === "approve") return json(await studio.approve(subject, id, await readJson(request)), 201);
      if (method === "POST" && operation === "reject") return json(await studio.reject(subject, id, await readJson(request)));
      if (method === "POST" && operation === "publish") return json(await studio.publish(subject, id));
    }
    return json(new SchoolOsError("not-found", "no such route").toBody(), 404);
  }

  return async (request) => {
    try {
      const subject = await resolveSubject(request);
      if (subject === undefined) return json(new SchoolOsError("unauthenticated", "sign in to use the Content Studio").toBody(), 401);
      return await route(request, subject);
    } catch (error) {
      if (error instanceof SchoolOsError) return json(error.toBody(), ERROR_STATUS[error.code]);
      return json({ code: "unavailable", message: "the request failed" }, 500);
    }
  };
}
