// The one-time migration of email-keyed users to principals (SCHO-259), by alias.
//
// Before a deployment binds PRINCIPAL_RESOLVER, its Access users' Durable Objects are named by
// email. Once it is bound, a sign-in names the DO `principal:<id>`, so without help every existing
// user would arrive at an empty account. Rather than copy each user's data into a new DO (a user
// DO holds workspaces, connected accounts, sessions, notification devices and more, much of it
// referenced from other objects by DO ID), the migration records an alias in the user directory:
// the principal's name resolves to the existing email-keyed user, whose DO stays authoritative and
// keeps its name, ID and every reference to it. Nothing is moved or deleted, so a run can be
// repeated, and stopped at any point, without loss.
//
// Matching is the district's (`PrincipalMigrationDirectory.matchEmailKeyedUsers`, over
// `planEmailKeyedMigration`): only an email exactly one person in the district has is aliased. The
// administrator who runs the migration reviews the dry run's mapping and confirms it by applying
// it (ADR-0003: never link silently). See docs/educateos/runbooks/production-instance.md.

import type { JWTPayload } from "jose";
import type {
  EmailKeyedUserMatch, PrincipalMigrationDirectory, PrincipalMigrationEntry,
  PrincipalMigrationOutcome, PrincipalMigrationReport, PrincipalResolver,
} from "@gadgets/workshop-shared/principal-resolver";
import { getAuthErrorCode } from "@gadgets/workshop-shared/api";
import { verifyCfAccessJwt, type CfAccessEnv } from "../access.js";
import { createWorkshopLogger } from "../observability.js";
import { isAdminUserName } from "./admins.js";
import { PRINCIPAL_USER_PREFIX, resolvePrincipalUser } from "./principal-sign-in.js";

const logger = createWorkshopLogger("workshop.principal-migration");

/** Where an administrator runs the migration: `POST {"apply": false}` for a dry run, `true` to apply. */
export const PRINCIPAL_MIGRATION_PATH = "/api/admin/principal-migration";

const PRINCIPAL_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The user directory's alias methods, as a stub to it offers them. */
export type AliasDirectory = Pick<
  DurableObjectStub<import("../user-directory.js").UserDirectoryDurableObject>,
  "listUserIds" | "principalAlias" | "listPrincipalAliases" | "addPrincipalAlias"
>;

/** The Durable Object namespaces sign-in and the migration reach. */
export type AliasExports = {
  UserDurableObject: Pick<Cloudflare.Exports["UserDurableObject"], "idFromName" | "get">;
  UserDirectoryDurableObject: Pick<Cloudflare.Exports["UserDirectoryDurableObject"], "getByName">;
};

type ResolverEnv = { PRINCIPAL_RESOLVER?: Pick<PrincipalResolver, "resolveAccessSignIn"> };

function aliasDirectory(exports: AliasExports): AliasDirectory {
  return exports.UserDirectoryDurableObject.getByName("");
}

/**
 * The user Durable Object name a verified Access sign-in uses, and the display name a new account
 * starts with.
 *
 * - Without PRINCIPAL_RESOLVER: the token's email, exactly as before.
 * - With it: `principal:<id>` for the principal it resolves to, unless the migration aliased that
 *   name to an existing user, whose name (its email) is used instead. A sign-in the resolver
 *   refuses throws, as `resolvePrincipalUser` does; it never falls back to the email.
 */
export async function accessUserName(env: ResolverEnv, exports: AliasExports, payload: JWTPayload)
    : Promise<{ name: string; displayName?: string }> {
  if (!env.PRINCIPAL_RESOLVER) return { name: payload.email as string };
  let user = await resolvePrincipalUser(env.PRINCIPAL_RESOLVER, payload);
  let alias = await aliasDirectory(exports).principalAlias(user.name);
  return alias === null ? user : { name: alias, displayName: user.displayName };
}

/** What the migration reads about user Durable Objects. */
export interface MigrationUsers {
  /** The hex ID of the DO `name` names. */
  workshopUserId(name: string): string;
  /** The workspaces (threads) the DO `name` lists. */
  threadCount(name: string): Promise<number>;
  /** True when the DO `name` holds an account. */
  accountExists(name: string): Promise<boolean>;
}

/** The user DOs of `exports`, as the migration reads them. */
export function migrationUsers(exports: AliasExports): MigrationUsers {
  let users = exports.UserDurableObject;
  let stub = (name: string) => users.get(users.idFromName(name));
  return {
    workshopUserId: name => users.idFromName(name).toString(),
    threadCount: async name => (await stub(name).listWorkspaces()).length,
    accountExists: async name => (await stub(name).whoamiIfExists()) !== null,
  };
}

/** What {@link migrateToPrincipals} runs over. */
export interface MigrationOptions {
  directory: AliasDirectory;
  matcher: Pick<PrincipalMigrationDirectory, "matchEmailKeyedUsers">;
  users: MigrationUsers;
  /** False for a dry run, which writes nothing. */
  apply: boolean;
}

/** An Access user named by email: neither a password username nor a principal. */
const isEmailKeyed = (name: string) => name.includes("@") && !name.startsWith(PRINCIPAL_USER_PREFIX);

const OUTCOMES: readonly PrincipalMigrationOutcome[] =
  ["alias", "already-aliased", "ambiguous", "cross-district", "unmatched", "conflict"];

/**
 * Plans, and with `apply` records, the aliases from principals to the existing email-keyed users
 * the district matches them with. Idempotent: a second run reports what the first aliased as
 * `already-aliased` and writes nothing new. A user is skipped as a `conflict`, never aliased, when
 * its principal already has an account of its own (aliasing would hide it), or when either side is
 * already aliased elsewhere.
 */
export async function migrateToPrincipals(options: MigrationOptions): Promise<PrincipalMigrationReport> {
  let { directory, matcher, users, apply } = options;
  let names = (await directory.listUserIds()).filter(isEmailKeyed).toSorted();
  let matches = names.length === 0 ? [] : await matcher.matchEmailKeyedUsers(
      names.map(email => ({ email, workshopUserId: users.workshopUserId(email) })));
  let matchByEmail = new Map<string, EmailKeyedUserMatch>();
  for (let match of matches) matchByEmail.set(match.email, match);
  let timesMatched = new Map<string, number>();
  for (let name of names) {
    let match = matchByEmail.get(name);
    if (match?.outcome === "exact-single") {
      timesMatched.set(match.principalId, (timesMatched.get(match.principalId) ?? 0) + 1);
    }
  }
  let aliases = await directory.listPrincipalAliases();
  let userOfPrincipal = new Map(aliases.map(a => [a.principal, a.user]));
  let principalOfUser = new Map(aliases.map(a => [a.user, a.principal]));

  let entries: PrincipalMigrationEntry[] = [];
  for (let user of names) {
    let threads = await users.threadCount(user);
    let match = matchByEmail.get(user) ?? { email: user, outcome: "unmatched" as const };
    if (match.outcome !== "exact-single") {
      entries.push({ user, outcome: match.outcome, threads });
      continue;
    }
    let { principalId } = match;
    let principal = PRINCIPAL_USER_PREFIX + principalId;
    let entry = (outcome: PrincipalMigrationOutcome, reason?: PrincipalMigrationEntry["reason"])
        : PrincipalMigrationEntry => ({ user, outcome, threads, principalId, ...(reason ? { reason } : {}) });

    let result: PrincipalMigrationEntry;
    if (!PRINCIPAL_ID.test(principalId)) {
      result = entry("conflict", "malformed-principal-id");
    } else if (timesMatched.get(principalId)! > 1) {
      result = entry("conflict", "principal-matched-twice");
    } else if (userOfPrincipal.get(principal) === user) {
      result = entry("already-aliased");
    } else if (userOfPrincipal.has(principal)) {
      result = entry("conflict", "principal-aliased-to-another-user");
    } else if (principalOfUser.has(user)) {
      result = entry("conflict", "user-aliased-to-another-principal");
    } else if (await users.accountExists(principal)) {
      result = entry("conflict", "principal-account-exists");
    } else if (!apply) {
      result = entry("alias");
    } else {
      // The directory checks both sides again as it writes, so a concurrent run cannot double up.
      let added = await directory.addPrincipalAlias(principal, user);
      result = added === "added" ? entry("alias")
          : added === "already-aliased" ? entry("already-aliased")
          : entry("conflict", "principal-aliased-to-another-user");
    }
    if (apply && (result.outcome === "alias" || result.outcome === "already-aliased")) {
      // Counted again the way sign-in reaches it: through the alias, from the principal's name.
      let aliased = await directory.principalAlias(principal);
      result.threadsViaPrincipal = aliased === null ? 0 : await users.threadCount(aliased);
    }
    entries.push(result);
  }

  let counts = Object.fromEntries(OUTCOMES.map(o => [o, 0])) as Record<PrincipalMigrationOutcome, number>;
  for (let entry of entries) counts[entry.outcome]++;
  return {
    applied: apply,
    users: entries.length,
    threads: entries.reduce((sum, entry) => sum + entry.threads, 0),
    counts,
    entries,
  };
}

type MigrationEnv = CfAccessEnv & ResolverEnv & {
  ADMINS?: string[] | string;
  PRINCIPAL_MIGRATION?: Pick<PrincipalMigrationDirectory, "matchEmailKeyedUsers">;
};

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: NO_STORE });
}

/**
 * Serves {@link PRINCIPAL_MIGRATION_PATH} to a deployment administrator (`ADMINS`) signed in through
 * Access. Not Found on a deployment with no district bound for it, which is every deployment until
 * its cutover, and on one without Access.
 */
export async function handlePrincipalMigrationRequest(
    req: Request, env: MigrationEnv, exports: AliasExports): Promise<Response> {
  let matcher = env.PRINCIPAL_MIGRATION ??
      (env.PRINCIPAL_RESOLVER as MigrationEnv["PRINCIPAL_MIGRATION"] | undefined);
  if (!matcher || !env.CF_ACCESS_AUD) return refuse(404, "Not Found");
  if (req.method !== "POST") return refuse(405, "Use POST.");
  if (req.headers.get("Origin") !== new URL(req.url).origin) {
    return refuse(403, "Cross-origin requests are not allowed.");
  }
  let payload = await verifyCfAccessJwt(req, env);
  if (!payload) return refuse(403, "Invalid CF access JWT.");
  let name: string;
  try {
    name = (await accessUserName(env, exports, payload)).name;
  } catch (error) {
    // Refused (403), or the resolver could not answer (503); either way the message says which.
    return refuse(getAuthErrorCode(error) === undefined ? 503 : 403, (error as Error).message);
  }
  if (!isAdminUserName(env, name)) {
    return refuse(403, "Only a Workshop administrator can run the principal migration.");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }
  let apply = (body as { apply?: unknown } | undefined)?.apply;
  if (typeof apply !== "boolean") return refuse(400, 'Send {"apply": false} for a dry run or {"apply": true}.');

  let report = await migrateToPrincipals({
    directory: aliasDirectory(exports),
    matcher,
    users: migrationUsers(exports),
    apply,
  });
  // Counts only: the entries name people.
  logger.info("the principal migration ran", {
    event: "principal.migration",
    principalMigration: { applied: apply, users: report.users, threads: report.threads, ...report.counts },
  });
  return Response.json(report, { headers: NO_STORE });
}
