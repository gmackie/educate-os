// Calls to a district's `/api/ops/*` (SCHO-263): each one signed with the workspace's ops key and
// the acting operator, and each answer parsed against the protocol's schema before anything else
// sees it. A redirect is a failure, not something to follow: on a district host it means the ops
// path isn't an Access bypass, and following it would send a signed request somewhere else.
import { signOpsRequest, type SigningIdentity } from "@educateos/fleet/ops";
import type { z } from "zod";

/** How long the admin waits for a district. */
export const DISTRICT_TIMEOUT_MS = 10_000;

/** What went wrong reaching a district, for the operator and the audit log. */
export class DistrictError extends Error {
  override readonly name = "DistrictError";
  /** The district's HTTP status, or 0 when it never answered. */
  readonly status: number;
  /** Short and fixed: `refused:403`, `unreachable`, `redirected`, `malformed`. Never the district's body. */
  readonly result: string;

  constructor(status: number, result: string, message: string) {
    super(message);
    this.status = status;
    this.result = result;
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
    await response.body?.cancel();
    throw new DistrictError(response.status, "redirected", "The district redirected the request. Is /api/ops an Access bypass path there?");
  }
  if (!response.ok) {
    await response.body?.cancel();
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
