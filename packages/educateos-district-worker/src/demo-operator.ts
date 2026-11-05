// The demo operator's seed route (SCHO-326): lets the operator seed a standalone demo district
// (riverbend, prairie, cedarvalley, lakeshore, harbor) without anyone's Access sign-in, with a bearer
// token, so the five can be seeded by a script alone. Like district.ts it imports nothing
// Workers-only, so it is type-checked on the web-standard surface.
//
// - `GET  /api/demo/operator/status`  the district's export (as `seed-district.ts export` saves it)
//                                     and what verification finds missing, read only.
// - `POST /api/demo/operator/seed`    exactly what `seed-district.ts run` does: the "before" export
//                                     (returned), the district's own fixture roster (additive only),
//                                     the middle school starter pack, verification. Body:
//                                     `{ dryRun?: boolean, admitSubject?: <Access user_uuid> }`.
//
// The gate. The routes exist only where all of these hold, and are 404 otherwise: the district's
// configuration has a `demo` setting, the Worker's committed `DEMO_SHOWCASE` var names the same
// showcase (only generated demo configs set it, {@link showcaseEnabled}), and the Worker has a
// `DEMO_OPERATOR_TOKEN` secret of at least {@link MIN_DEMO_OPERATOR_TOKEN_LENGTH} characters. A
// district whose ID is not a standalone demo district's fixture has nothing to seed (404).
//
// Authentication. Access bypasses these paths (`/api/demo/operator/*` is in the demo districts' bypass
// application), so the token is the only credential: `authorization: Bearer <token>`, compared in
// constant time (SHA-256 of both, then a full-length XOR). A missing or wrong token is 401 with no
// detail; more than {@link MAX_FAILURES} of those in {@link FAILURE_WINDOW_MS} close the routes to
// everyone for the rest of the window (429). The token is never logged or echoed.
//
// Who acts. The district's own administrator: the first principal in the directory's role
// assignments holding district-admin at district scope, in force, active and staff (the one the
// district's DISTRICT_CONFIG seeded). Every step is that person's request, served in-process through
// `DistrictApp.serveAs`, so it goes through the same routes, schemas and policy (and audit) as their
// own browser's would. The operator gains nothing an administrator lacks, and the seed only adds.
import { z } from "zod";
import { ERROR_STATUS } from "@educateos/academics";
import { EducateOsError, roleAssignmentInForce, type DistrictDirectorySnapshot, type PrincipalId } from "@educateos/contracts";
import type { DistrictApp } from "@educateos/district-app";
import {
  DEMO_STARTER_PACK,
  demoForDistrictId,
  exportDistrict,
  listingOf,
  seedDemoDistrict,
  verify,
  type DistrictAdminClient,
} from "@educateos/harness/demo-district";
import { showcaseEnabled } from "./showcase.ts";
import type { DistrictWorkerConfig } from "./config.ts";

/** The prefix of the operator's routes, under the showcase's {@link DEMO_API_PREFIX}. */
export const DEMO_OPERATOR_PREFIX = "/api/demo/operator/";

/** The shortest `DEMO_OPERATOR_TOKEN` that turns the routes on. */
export const MIN_DEMO_OPERATOR_TOKEN_LENGTH = 32;

/** Failed authentications allowed per window before the routes close for the rest of it. */
export const MAX_FAILURES = 10;

/** The failure-counting window. */
export const FAILURE_WINDOW_MS = 60_000;

/**
 * Whether the operator routes are on: a demo configuration, the deployment's `DEMO_SHOWCASE` naming
 * its showcase, and a long enough `DEMO_OPERATOR_TOKEN` (leading and trailing whitespace, such as a
 * newline a secret was piped in with, is not part of it). Any one missing is off.
 */
export function demoOperatorEnabled(demo: DistrictWorkerConfig["demo"], deployedShowcase: string | undefined, token: string | undefined): token is string {
  return showcaseEnabled(demo, deployedShowcase) !== undefined && token !== undefined && token.trim().length >= MIN_DEMO_OPERATOR_TOKEN_LENGTH;
}

/**
 * The administrator the operator acts as: the first district-admin grant at district scope, in
 * force at `at`, whose principal is active staff. None, when the district has no such person.
 */
export function operatorAdministrator(snapshot: DistrictDirectorySnapshot, at: Date): PrincipalId | undefined {
  for (const grant of snapshot.roleAssignments) {
    if (grant.role !== "district-admin" || grant.scope.level !== "district" || !roleAssignmentInForce(grant, at)) continue;
    const principal = snapshot.principals.find((p) => p.id === grant.principalId);
    if (principal?.kind === "staff" && principal.status === "active") return principal.id;
  }
  return undefined;
}

const encoder = new TextEncoder();

/** Whether `presented` is `expected`, in time that depends on neither: both are hashed, and every byte compared. */
export async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([presented, expected].map(async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))));
  let difference = 0;
  for (let i = 0; i < a!.length; i++) difference |= a![i]! ^ b![i]!;
  return difference === 0;
}

/** The seed route's body. */
export const OperatorSeedRequest = z.strictObject({
  /** Only say what the district would gain; write nothing. */
  dryRun: z.boolean().optional(),
  /** An Access subject (`user_uuid`) to admit as "EducateOS demo automation", a district administrator. */
  admitSubject: z.uuid().optional(),
});

/** What the seed route answers. */
export interface OperatorSeedResult {
  districtId: string;
  /** The demo district's slug, from its fixture. */
  slug: string;
  dryRun: boolean;
  /** The administrator every step was served as. */
  adminPrincipalId: string;
  /** The "before" export, taken before anything was changed. */
  before: Record<string, unknown>;
  /** What the run did, line by line. */
  log: string[];
  /** What it refused, or found missing afterwards. Empty: success. */
  problems: string[];
}

/** What the status route answers. */
export interface OperatorStatus {
  districtId: string;
  slug: string;
  adminPrincipalId: string;
  /** The district as the admin read routes say it is now. */
  export: Record<string, unknown>;
  /** What verification finds missing. Empty: the fixture and the pack are all there. */
  problems: string[];
}

/** What the operator routes log: outcomes by counts and IDs. Never the token, a header or a subject. */
export interface DemoOperatorEvent {
  event: "demo.operator.status" | "demo.operator.seeded" | "demo.operator.refused" | "demo.operator.failed";
  districtId: string;
  correlationId: string;
  /** The administrator served as. */
  principalId?: string;
  dryRun?: boolean;
  problems?: number;
  /** Why a request was refused: `unauthenticated` or `rate-limited`. */
  reason?: "unauthenticated" | "rate-limited";
  error?: unknown;
}

/** What the operator routes are built from. */
export interface DemoOperatorOptions {
  /** The running district. */
  app: DistrictApp;
  /** `DEMO_OPERATOR_TOKEN`, without its leading and trailing whitespace. */
  token: string;
  /** The starter pack bundle to install; `DEMO_STARTER_PACK` (bundled into the Worker) by default. */
  pack?: unknown;
  /** Told what each request did, to log it. */
  onEvent?: (event: DemoOperatorEvent) => void;
  /** The clock, for the failure window. */
  now?: () => number;
}

/** The demo operator's routes. */
export interface DemoOperator {
  /** Serves `/api/demo/operator/*`. */
  serve(request: Request): Promise<Response>;
}

/** A step the district refused while seeding: its status, code and message, never its body. */
class StepError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Starts the operator routes for `options.app`. Call only when {@link demoOperatorEnabled}. */
export function startDemoOperator(options: DemoOperatorOptions): DemoOperator {
  const { app } = options;
  const districtId = app.districtId;
  const now = options.now ?? Date.now;
  const pack = options.pack ?? DEMO_STARTER_PACK;
  const token = options.token.trim();
  const emit = (event: Omit<DemoOperatorEvent, "districtId">) => options.onEvent?.({ ...event, districtId });
  let failures: { since: number; count: number } = { since: 0, count: 0 };

  /** `principalId`'s own admin routes, served in-process under their own policy. */
  function clientFor(principalId: PrincipalId, origin: string): DistrictAdminClient {
    async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
      const response = await app.serveAs({ principalId, districtId }, new Request(`${origin}${path}`, {
        method,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      const parsed = await response.json() as { code?: string; message?: string };
      if (!response.ok) throw new StepError(response.status, parsed.code ?? "unavailable", `${method} ${path}: ${parsed.message ?? ""}`.slice(0, 500));
      return parsed as T;
    }
    return { get: (path) => request("GET", path), post: (path, body) => request("POST", path, body) };
  }

  /** The demo district and its administrator, or `not-found`/`unavailable`. */
  async function target() {
    const demo = demoForDistrictId(districtId);
    if (demo === undefined) throw new EducateOsError("not-found", "This district is not a standalone demo district.");
    const { snapshot } = await app.stores.directory.load();
    const adminPrincipalId = operatorAdministrator(snapshot, new Date(now()));
    if (adminPrincipalId === undefined) throw new EducateOsError("unavailable", "The district has no active district administrator to seed as.");
    return { demo, adminPrincipalId };
  }

  /** Whether the request carries the token. Counts failures; throws once the window's are spent. */
  async function authenticate(request: Request, correlationId: string): Promise<void> {
    const at = now();
    if (at - failures.since >= FAILURE_WINDOW_MS) failures = { since: at, count: 0 };
    if (failures.count >= MAX_FAILURES) {
      emit({ event: "demo.operator.refused", correlationId, reason: "rate-limited" });
      throw new RateLimited();
    }
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "");
    if (match === null || !(await tokenMatches(match[1]!, token))) {
      failures.count++;
      emit({ event: "demo.operator.refused", correlationId, reason: "unauthenticated" });
      throw new EducateOsError("unauthenticated", "Unauthorized.");
    }
  }

  return {
    async serve(request) {
      const correlationId = crypto.randomUUID();
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname.slice(DEMO_OPERATOR_PREFIX.length)}`;
      let principalId: PrincipalId | undefined;
      try {
        if (route !== "GET status" && route !== "POST seed") throw new EducateOsError("not-found", "No such route.");
        await authenticate(request, correlationId);
        if (route === "GET status") {
          const { demo, adminPrincipalId } = await target();
          principalId = adminPrincipalId;
          const client = clientFor(adminPrincipalId, url.origin);
          const exported = await exportDistrict(client);
          const problems = await verify(client, demo, listingOf(pack).listingId, () => {});
          emit({ event: "demo.operator.status", correlationId, principalId, problems: problems.length });
          return json({ districtId, slug: demo.slug, adminPrincipalId, export: exported, problems } satisfies OperatorStatus, correlationId);
        }
        // Every POST must say it is JSON.
        if (!/^application\/json(;|$)/i.test(request.headers.get("content-type") ?? "")) {
          throw new EducateOsError("validation-failed", "Send the request as application/json.");
        }
        const parsed = OperatorSeedRequest.safeParse(await request.json().catch(() => undefined));
        if (!parsed.success) {
          throw new EducateOsError("validation-failed", `The request body is invalid at: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))].join(", ")}`);
        }
        const body = parsed.data;
        const { demo, adminPrincipalId } = await target();
        principalId = adminPrincipalId;
        const log: string[] = [];
        const dryRun = body.dryRun === true;
        const { before, problems } = await seedDemoDistrict({
          client: clientFor(adminPrincipalId, url.origin),
          demo,
          dryRun,
          pack,
          log: (line) => void log.push(line),
          saveBefore: async () => {},
          ...(body.admitSubject === undefined ? {} : { admitSubject: body.admitSubject }),
        });
        emit({ event: "demo.operator.seeded", correlationId, principalId, dryRun, problems: problems.length });
        return json({ districtId, slug: demo.slug, dryRun, adminPrincipalId, before, log, problems } satisfies OperatorSeedResult, correlationId);
      } catch (error) {
        if (!request.bodyUsed) await request.body?.cancel();
        if (error instanceof RateLimited) return json({ code: "rate-limited", message: "Too many attempts; try again later." }, correlationId, 429);
        if (error instanceof EducateOsError) {
          const response = json(error.toBody(), correlationId, ERROR_STATUS[error.code]);
          if (error.code === "unauthenticated") response.headers.set("www-authenticate", "Bearer");
          return response;
        }
        if (error instanceof StepError) return json({ code: error.code, message: error.message }, correlationId, error.status);
        emit({ event: "demo.operator.failed", correlationId, ...(principalId === undefined ? {} : { principalId }), error });
        return json({ code: "unavailable", message: "The operator request could not be completed." }, correlationId, 503);
      }
    },
  };
}

/** Too many failed authentications in the window. */
class RateLimited extends Error {}

function json(body: unknown, correlationId: string, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-correlation-id": correlationId } });
}
