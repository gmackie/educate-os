import { z } from "zod";
import { EducateOsError, type EducateOsErrorBody } from "@educateos/contracts";
import { ERROR_STATUS } from "@educateos/academics";
import { ROUTES, type RouteName, type RouteSpec } from "./routes.ts";

/** The response header carrying the request's correlation ID, which its audit events share. */
export const CORRELATION_HEADER = "x-correlation-id";

/** The largest JSON body accepted, in UTF-16 code units: a roster export with headroom. */
const MAX_BODY_CHARS = 8 * 1024 * 1024;

/** A route matched against a request, with its raw path parameters. */
export interface MatchedRoute {
  name: RouteName;
  spec: RouteSpec;
  params: Record<string, string>;
}

interface CompiledRoute {
  name: RouteName;
  spec: RouteSpec;
  segments: string[];
}

// Literal segments win over parameters, so `/workspaces/personal` is never read as a workspace ID.
const COMPILED: readonly CompiledRoute[] = (Object.entries(ROUTES) as [RouteName, RouteSpec][])
  .map(([name, spec]) => ({ name, spec, segments: spec.path.split("/").slice(1) }))
  .toSorted((a, b) => a.segments.filter((s) => s.startsWith(":")).length - b.segments.filter((s) => s.startsWith(":")).length);

/** The route a request names, or undefined. A segment that is not valid percent-encoding matches nothing. */
export function matchRoute(method: string, pathname: string): MatchedRoute | undefined {
  const segments = pathname.split("/").slice(1);
  for (const route of COMPILED) {
    if (route.spec.method !== method || route.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (const [index, pattern] of route.segments.entries()) {
      const actual = segments[index]!;
      if (pattern.startsWith(":")) {
        try {
          params[pattern.slice(1)] = decodeURIComponent(actual);
        } catch {
          matched = false;
        }
      } else if (pattern !== actual) {
        matched = false;
      }
      if (!matched) break;
    }
    if (matched) return { name: route.name, spec: route.spec, params };
  }
  return undefined;
}

/** Names each invalid field and why, without echoing any submitted value. */
export function describeIssues(where: string, error: z.ZodError): string {
  const issues = error.issues.map((issue) =>
    issue.code === "unrecognized_keys"
      ? `unknown field(s) ${issue.keys.join(", ")}`
      : `${issue.path.join(".") || "(value)"}: ${issue.code}`
  );
  return `The ${where} is invalid: ${issues.join("; ")}`.slice(0, 1000);
}

/** Parses `value` with `schema`, or throws `validation-failed` naming the part of the request at fault. */
export function parsePart<S extends z.ZodType>(where: string, schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", describeIssues(where, parsed.error));
  return parsed.data;
}

/** Reads a request's JSON body. An empty body reads as `{}`, so bodiless actions need no payload. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new EducateOsError("validation-failed", "The request body is too large.");
  if (text.trim() === "") return {};
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(;|$)/i.test(type)) throw new EducateOsError("validation-failed", "Send the request body as application/json.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EducateOsError("validation-failed", "The request body is not valid JSON.");
  }
}

/** A JSON response carrying the correlation ID. Responses are never cached: they are per principal. */
export function jsonResponse(body: unknown, status: number, correlationId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", [CORRELATION_HEADER]: correlationId },
  });
}

/**
 * The error response for anything a handler threw. A `EducateOsError` keeps its code and message;
 * a Zod error from a domain service's own parsing is `validation-failed`; anything else is logged
 * here, the only record of it, and answered `unavailable` with nothing internal in the body.
 */
export function errorResponse(error: unknown, correlationId: string, route: string): Response {
  let body: EducateOsErrorBody;
  if (error instanceof EducateOsError) {
    body = { ...error.toBody(), correlationId };
  } else if (error instanceof z.ZodError) {
    body = { code: "validation-failed", message: describeIssues("request", error), correlationId };
  } else {
    console.error("district app request failed", { route, correlationId, error });
    body = { code: "unavailable", message: "The request could not be completed.", correlationId };
  }
  return jsonResponse(body, ERROR_STATUS[body.code], correlationId);
}
