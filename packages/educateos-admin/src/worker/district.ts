// Calls to a district's `/api/ops/*` (SCHO-263): each one signed with the workspace's ops key and
// the acting operator, and each answer parsed against the protocol's schema before anything else
// sees it. A redirect is a failure, not something to follow: on a district host it means the ops
// path isn't an Access bypass, and following it would send a signed request somewhere else.
//
// A district that doesn't serve the ops API yet is told apart from one that refuses a request
// (result `ops-not-enabled`): Access redirecting the call, a 404 for a route with no identifier in
// its path (only a district without the API has no /api/ops/health), and any 401, 403 or 404 whose
// body isn't the protocol's error body (Access, or a district Worker without /api/ops, answered).
import { matchOpsRoute, OpsErrorBody, signOpsRequest, type SigningIdentity } from "@educateos/fleet/ops";
import type { z } from "zod";

/** How long the admin waits for a district. */
export const DISTRICT_TIMEOUT_MS = 10_000;

/** What went wrong reaching a district, for the operator and the audit log. */
export class DistrictError extends Error {
  override readonly name = "DistrictError";
  /** The district's HTTP status, or 0 when it never answered. */
  readonly status: number;
  /** Short and fixed: `refused:403`, `unreachable`, `ops-not-enabled`, `malformed`. Never the district's body. */
  readonly result: string;

  constructor(status: number, result: string, message: string) {
    super(message);
    this.status = status;
    this.result = result;
  }
}

/** What the admin says when a district doesn't serve the ops API. */
export const OPS_NOT_ENABLED_MESSAGE =
  "Operations not enabled for this workspace. Its district doesn't answer the ops API (/api/ops) yet, so health, analytics, people and devices aren't available here.";

/** The most of an error body the admin reads, to tell the protocol's error body from anything else. */
const MAX_ERROR_BODY_BYTES = 4096;

/** Reads at most `limit` bytes of a body as text, then drops the rest. */
async function boundedText(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= limit) {
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, limit));
}

/** Whether a body is the ops protocol's error body. */
function isOpsErrorBody(text: string): boolean {
  try {
    return OpsErrorBody.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/** Sends a request: the global fetch in production, a fake district in tests. */
export type FetchLike = (request: Request) => Promise<Response>;

/** One signed call. */
export interface DistrictCall<T extends z.ZodType> {
  origin: string;
  identity: SigningIdentity;
  operator: string;
  method: "GET" | "POST";
  /** The ops path and query, such as `/api/ops/analytics?range=7d`. */
  target: string;
  body?: unknown;
  schema: T;
  fetch: FetchLike;
  now?: Date;
}

/** Signs and sends one ops request, and parses the answer. Throws {@link DistrictError}. */
export async function callDistrict<T extends z.ZodType>(call: DistrictCall<T>): Promise<z.infer<T>> {
  const url = new URL(call.target, call.origin);
  if (url.origin !== call.origin || !url.pathname.startsWith("/api/ops/")) throw new Error("not an ops path on the workspace's origin");
  const body = call.body === undefined ? undefined : JSON.stringify(call.body);
  const signed = await signOpsRequest(call.identity, {
    method: call.method,
    url,
    operator: call.operator,
    ...(body === undefined ? {} : { body }),
    ...(call.now === undefined ? {} : { now: call.now }),
  });
  const headers = new Headers(signed);
  headers.set("accept", "application/json");
  if (body !== undefined) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await call.fetch(new Request(url, {
      method: call.method,
      headers,
      // workerd refuses `redirect: "error"`; "manual" hands the 3xx back to be refused below.
      redirect: "manual",
      signal: AbortSignal.timeout(DISTRICT_TIMEOUT_MS),
      ...(body === undefined ? {} : { body }),
    }));
  } catch {
    throw new DistrictError(0, "unreachable", "The district could not be reached.");
  }
  if (response.status >= 300 && response.status < 400) {
    // Access sends a request for a path that isn't a bypass to its sign-in page.
    await response.body?.cancel();
    throw new DistrictError(response.status, "ops-not-enabled", OPS_NOT_ENABLED_MESSAGE);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      const fromOps = isOpsErrorBody(await boundedText(response, MAX_ERROR_BODY_BYTES));
      const identifiesSomething = matchOpsRoute(call.method, url.pathname)?.route.path.includes(":") ?? false;
      if (!fromOps || (response.status === 404 && !identifiesSomething)) {
        throw new DistrictError(response.status, "ops-not-enabled", OPS_NOT_ENABLED_MESSAGE);
      }
    } else {
      await response.body?.cancel();
    }
    const message = response.status === 401
      ? "The district did not accept this admin's key. Has the key been registered there, or removed?"
      : response.status === 403
        ? "The district has not granted this admin the access this needs."
        : `The district answered ${response.status}.`;
    throw new DistrictError(response.status, `refused:${response.status}`, message);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new DistrictError(response.status, "malformed", "The district's answer was not JSON.");
  }
  const parsed = call.schema.safeParse(json);
  if (!parsed.success) throw new DistrictError(response.status, "malformed", "The district's answer did not match the ops protocol.");
  return parsed.data;
}
