// Point-in-time recovery of the district's Durable Object (SCHO-373): the routes an operator restores
// the district's SQLite storage with, to any moment in the last 30 days, using the platform's
// bookmarks (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/). Every store
// of the district application is in that one object (district-object.ts), so one restore returns
// the whole district to one consistent moment. The runbook is docs/educateos/runbooks/backup-and-restore.md.
//
// - `GET  /api/recovery/bookmark[?at=<time>]`  the current bookmark, and the bookmark for `at` (an
//                                              ISO 8601 time or epoch milliseconds). Reads nothing.
// - `POST /api/recovery/restore`               body `{ districtId, bookmark }`: schedules the restore,
//                                              answers the bookmark that undoes it, then restarts
//                                              the object, which comes back at `bookmark`.
//
// The gate. The routes exist only while the Worker has a `RECOVERY_TOKEN` secret of at least
// {@link MIN_RECOVERY_TOKEN_LENGTH} characters, and are 404 otherwise. The runbook sets the secret
// for the length of a recovery and deletes it afterwards, so a district runs with them off.
//
// Authentication. Two things, both required: a Cloudflare Access assertion the district verifies
// itself (Access is not bypassed on these paths, so the operator has signed in to the district's
// Access application), and `authorization: Bearer <RECOVERY_TOKEN>`, compared in constant time.
// Setting a Worker secret needs Workers Scripts: Edit on the district's Cloudflare account, so the
// token proves account-level control. Neither depends on the district's own records: the routes are
// served before the district application starts, so a district whose records are damaged, or that
// no longer starts, can still be restored. The token is never logged or echoed.
//
// Like district.ts this module imports nothing Workers-only: storage and the restart are passed in.
import { z } from "zod";
import type { VerifiedIdentity } from "@educateos/contracts";
import { tokenMatches } from "./demo-operator.ts";

/** The prefix of the recovery routes. */
export const RECOVERY_PREFIX = "/api/recovery/";

/** The shortest `RECOVERY_TOKEN` that turns the routes on. */
export const MIN_RECOVERY_TOKEN_LENGTH = 32;

/** How far back the platform keeps a SQLite Durable Object's history. */
export const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The part of `DurableObjectStorage` recovery uses. */
export interface RecoveryStorage {
  getCurrentBookmark(): Promise<string>;
  getBookmarkForTime(timestamp: number | Date): Promise<string>;
  onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
}

/** What a recovery route logs: bookmarks and the operator's Access identity, never the token. */
export interface RecoveryEvent {
  event: "district.recovery.bookmark" | "district.recovery.restore" | "district.recovery.refused" | "district.recovery.failed";
  bookmark?: string;
  undoBookmark?: string;
  operatorIssuer?: string;
  operatorSubject?: string;
  status?: number;
  error?: unknown;
}

/** What the recovery routes need from the object that serves them. */
export interface RecoveryOptions {
  /** The district this object holds, from `DISTRICT_CONFIG`. A restore must name it. */
  districtId: string;
  /** The Worker's `RECOVERY_TOKEN` secret, if set. */
  token: string | undefined;
  /** Verifies the request's Access assertion; `undefined` when it proves no one. */
  verifyAccess(request: Request): Promise<VerifiedIdentity | undefined>;
  storage: RecoveryStorage;
  /** Restarts the object once the restore's response is on its way, so the restore takes effect. */
  restart(): void;
  onEvent(event: RecoveryEvent): void;
  /** The clock, for checking `at`. */
  now?: () => Date;
}

/** Whether the recovery routes are on: a long enough `RECOVERY_TOKEN` (surrounding whitespace is not part of it). */
export function recoveryEnabled(token: string | undefined): token is string {
  return token !== undefined && token.trim().length >= MIN_RECOVERY_TOKEN_LENGTH;
}

/** A bookmark as the platform writes them: hex groups separated by hyphens, lexically comparable. */
export const RecoveryBookmark = z.string().regex(/^[0-9a-f]+(-[0-9a-f]+)*$/i, "expected a Durable Object bookmark").max(256);

/** The restore route's body. */
export const RecoveryRestoreRequest = z.strictObject({
  /** The district being restored, as a check against restoring the wrong one. */
  districtId: z.string().min(1),
  /** The bookmark to restore to, from the bookmark route. */
  bookmark: RecoveryBookmark,
});

/** The bookmark route's answer. */
export interface RecoveryBookmarkResponse {
  districtId: string;
  current: string;
  at?: { requested: string; bookmark: string };
}

/** The restore route's answer. */
export interface RecoveryRestoreResponse {
  districtId: string;
  restoredTo: string;
  /** Restoring to this bookmark undoes the restore. Keep it until the restore is verified. */
  undoBookmark: string;
}

/** The message workerd's local storage back-end refuses a restore with. */
const LOCAL_BACKEND_REFUSAL = "does not implement point-in-time recovery";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function error(code: string, message: string, status: number): Response {
  return json({ code, message }, status);
}

/** `at` as a time: epoch milliseconds, or anything `Date` parses (ISO 8601). */
function parseAt(at: string): Date | undefined {
  const date = /^\d+$/.test(at) ? new Date(Number(at)) : new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Serves one request under {@link RECOVERY_PREFIX}. */
export async function serveRecovery(request: Request, options: RecoveryOptions): Promise<Response> {
  const { districtId, storage, onEvent } = options;
  if (!recoveryEnabled(options.token)) {
    await request.body?.cancel();
    return error("not-found", "No such route.", 404);
  }
  const refuse = async (status: number, code: string, message: string) => {
    await request.body?.cancel();
    onEvent({ event: "district.recovery.refused", status });
    return error(code, message, status);
  };
  const presented = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (presented === undefined || !await tokenMatches(presented, options.token.trim())) return refuse(401, "unauthenticated", "Not signed in.");
  const operator = await options.verifyAccess(request);
  if (operator === undefined) return refuse(401, "unauthenticated", "Not signed in.");
  const who = { operatorIssuer: operator.issuer, operatorSubject: operator.subject };

  const { pathname, searchParams } = new URL(request.url);
  const route = `${request.method} ${pathname.slice(RECOVERY_PREFIX.length)}`;
  try {
    if (route === "GET bookmark") {
      const body: RecoveryBookmarkResponse = { districtId, current: await storage.getCurrentBookmark() };
      const at = searchParams.get("at");
      if (at !== null) {
        const time = parseAt(at);
        const now = (options.now ?? (() => new Date()))().getTime();
        if (time === undefined) return error("invalid-request", "`at` must be an ISO 8601 time or epoch milliseconds.", 400);
        if (time.getTime() > now) return error("invalid-request", "`at` is in the future.", 400);
        if (time.getTime() < now - RECOVERY_WINDOW_MS) return error("invalid-request", "`at` is more than 30 days ago, outside the recovery window.", 400);
        body.at = { requested: time.toISOString(), bookmark: await storage.getBookmarkForTime(time) };
      }
      onEvent({ event: "district.recovery.bookmark", bookmark: body.at?.bookmark ?? body.current, ...who });
      return json(body, 200);
    }
    if (route === "POST restore") {
      let parsed;
      try {
        parsed = RecoveryRestoreRequest.safeParse(await request.json());
      } catch {
        return error("invalid-request", "The body must be JSON.", 400);
      }
      if (!parsed.success) return error("invalid-request", "The body must be `{ districtId, bookmark }`.", 400);
      if (parsed.data.districtId !== districtId) return error("district-mismatch", "This Worker holds a different district.", 409);
      const undoBookmark = await storage.onNextSessionRestoreBookmark(parsed.data.bookmark);
      onEvent({ event: "district.recovery.restore", bookmark: parsed.data.bookmark, undoBookmark, ...who });
      options.restart();
      const body: RecoveryRestoreResponse = { districtId, restoredTo: parsed.data.bookmark, undoBookmark };
      return json(body, 202);
    }
    await request.body?.cancel();
    return error("not-found", "No such route.", 404);
  } catch (cause) {
    onEvent({ event: "district.recovery.failed", error: cause, ...who });
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes(LOCAL_BACKEND_REFUSAL)) {
      return error("recovery-unavailable", "This storage back-end keeps no history to restore from (local development has none).", 501);
    }
    return error("recovery-failed", message, 502);
  }
}
