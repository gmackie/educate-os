import { SchoolOsError, type ErrorCode, type SchoolOsErrorBody, type VerifiedPrincipal } from "@schoolos/contracts";
import type { AcademicDirectory } from "./directory.ts";
import { ACADEMIC_OPERATIONS, invokeOperation, type AcademicOperationName } from "./operations.ts";

/** The HTTP status each error code is returned with. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  "unauthenticated": 401,
  "forbidden": 403,
  "not-found": 404,
  "conflict": 409,
  "validation-failed": 400,
  "policy-violation": 403,
  "budget-exceeded": 429,
  "unavailable": 503,
};

interface Route {
  method: "GET" | "POST" | "PATCH";
  /** Path segments; `:name` captures one segment as input field `name`. */
  segments: string[];
  operation: AcademicOperationName;
  status: 200 | 201;
}

function route(method: Route["method"], path: string, operation: AcademicOperationName, status: 200 | 201 = 200): Route {
  return { method, segments: path.split("/").filter(Boolean), operation, status };
}

/** Every route the fallback service serves, each a thin binding of an operation. */
const ROUTES: readonly Route[] = [
  route("GET", "/schools", "list_schools"),
  route("POST", "/schools", "create_school", 201),
  route("GET", "/schools/:schoolId", "get_school"),
  route("PATCH", "/schools/:schoolId", "update_school"),
  route("GET", "/terms", "list_terms"),
  route("POST", "/terms", "create_term", 201),
  route("GET", "/terms/:termId", "get_term"),
  route("PATCH", "/terms/:termId", "update_term"),
  route("POST", "/terms/:termId/transition", "transition_term"),
  route("GET", "/courses", "list_courses"),
  route("POST", "/courses", "create_course", 201),
  route("GET", "/courses/:courseId", "get_course"),
  route("PATCH", "/courses/:courseId", "update_course"),
  route("GET", "/offerings", "list_offerings"),
  route("POST", "/offerings", "create_offering", 201),
  route("GET", "/offerings/:offeringId", "get_offering"),
  route("PATCH", "/offerings/:offeringId", "update_offering"),
  route("GET", "/offerings/:offeringId/roster", "get_roster"),
  route("GET", "/enrollments", "list_enrollments"),
  route("POST", "/enrollments", "create_enrollment", 201),
  route("GET", "/enrollments/:enrollmentId", "get_enrollment"),
  route("POST", "/enrollments/:enrollmentId/deactivate", "deactivate_enrollment"),
  route("GET", "/me/enrollments", "my_enrollments"),
  route("POST", "/principals/:principalId/status", "set_principal_status"),
];

function match(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
  let segments: string[];
  try {
    segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  for (const candidate of ROUTES) {
    if (candidate.method !== method || candidate.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matched = candidate.segments.every((segment, i) => {
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = segments[i]!;
        return true;
      }
      return segment === segments[i];
    });
    if (matched) return { route: candidate, params };
  }
  return undefined;
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(body: SchoolOsErrorBody): Response {
  return json(ERROR_STATUS[body.code], body);
}

/**
 * The operation's input: path parameters, query parameters and the JSON body, as one object. A
 * name supplied in more than one place is refused rather than letting one silently win, so a body
 * cannot redirect a write to a different record than the path names.
 */
async function readInput(request: Request, url: URL, params: Record<string, string>): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = { ...params };
  const add = (key: string, value: unknown) => {
    if (Object.hasOwn(input, key)) throw new SchoolOsError("validation-failed", `${key} was given more than once.`);
    input[key] = value;
  };
  for (const [key, value] of url.searchParams) add(key, value);
  if (request.method === "GET") return input;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new SchoolOsError("validation-failed", "The request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SchoolOsError("validation-failed", "The request body must be a JSON object.");
  }
  for (const [key, value] of Object.entries(body)) add(key, value);
  return input;
}

/** What {@link createAcademicsHandler} is built from. */
export interface AcademicsHandlerOptions {
  /** The district's directory. */
  directory: AcademicDirectory;
  /**
   * Authenticates the request and returns its verified principal, or `undefined` if it carries no
   * valid credential. Authentication is the caller's concern; this handler never inspects
   * credentials itself.
   */
  resolvePrincipal(request: Request): Promise<VerifiedPrincipal | undefined>;
}

/**
 * The fallback service's HTTP surface as a fetch-standard handler, so it runs unchanged under Node
 * and workerd. Every route is a binding of an entry in `ACADEMIC_OPERATIONS`: inputs are validated
 * with the contract schemas, and errors are returned as `SchoolOsErrorBody`, each with the
 * request's correlation ID, under which its authorization decisions were audited. Requests are
 * authenticated before routing, so an anonymous caller learns nothing about which paths exist.
 */
export function createAcademicsHandler(options: AcademicsHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const correlationId = crypto.randomUUID();
    const fail = (body: SchoolOsErrorBody) => errorResponse({ ...body, correlationId });
    let principal: VerifiedPrincipal | undefined;
    try {
      principal = await options.resolvePrincipal(request);
    } catch (error) {
      if (error instanceof SchoolOsError) return fail(error.toBody());
      console.error("academics principal resolution failed", { correlationId, error });
      return fail({ code: "unavailable", message: "Authentication is unavailable." });
    }
    if (principal === undefined) {
      return fail({ code: "unauthenticated", message: "Sign in to use the academic directory." });
    }

    const url = new URL(request.url);
    const matched = match(request.method, url.pathname);
    if (matched === undefined) return fail({ code: "not-found", message: "No such route." });

    let input: Record<string, unknown>;
    try {
      input = await readInput(request, url, matched.params);
    } catch (error) {
      if (error instanceof SchoolOsError) return fail(error.toBody());
      throw error;
    }

    const outcome = await invokeOperation(
      ACADEMIC_OPERATIONS[matched.route.operation],
      options.directory,
      { principal, channel: "http", correlationId },
      input,
    );
    return outcome.ok ? json(matched.route.status, outcome.value) : errorResponse(outcome.error);
  };
}
