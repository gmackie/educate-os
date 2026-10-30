import type { UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";

const SEARCH_RESULT_LIMIT = 10;
// Every authenticated user can reach this one DO, so a search bounds what it is asked to scan.
const MAX_QUERY_LENGTH = 1000;
const MAX_EXCLUDE_IDS = 1000;

/**
 * Deployment-wide directory of user profiles, so a user can find collaborators
 * by name or id. Each user DO mirrors updates to its own profile here
 * (`UserDurableObject.#syncDirectory`).
 */
export class UserDirectoryDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      search_text TEXT NOT NULL,
      rev INTEGER NOT NULL
    ) STRICT`);
    // The one-time migration of email-keyed users to principals (auth/principal-aliases.ts): a
    // principal's user name resolves to the existing user it was matched with, whose Durable Object
    // stays authoritative. Rows are only ever added; each side appears at most once.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS principal_aliases (
      principal TEXT PRIMARY KEY,
      user TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT`);
  }

  /** Every user id the directory holds, sorted. For the principal migration's inventory. */
  listUserIds(): string[] {
    return this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM users ORDER BY id`)
        .toArray().map(row => row.id);
  }

  /** The existing user `principal` (a `principal:<id>` name) is an alias of, or null. */
  principalAlias(principal: string): string | null {
    let rows = this.ctx.storage.sql.exec<{ user: string }>(
      `SELECT user FROM principal_aliases WHERE principal = ?`, principal).toArray();
    return rows[0]?.user ?? null;
  }

  /** Every alias, sorted by principal. */
  listPrincipalAliases(): { principal: string; user: string }[] {
    return this.ctx.storage.sql.exec<{ principal: string; user: string }>(
      `SELECT principal, user FROM principal_aliases ORDER BY principal`).toArray();
  }

  /**
   * Records that `principal` resolves to the existing user `user`. Idempotent: the same pair again
   * is `already-aliased`. Refuses (`conflict`, writing nothing) when either side is already aliased
   * to someone else, so one user's data is never reachable from two principals or vice versa.
   */
  addPrincipalAlias(principal: string, user: string): "added" | "already-aliased" | "conflict" {
    let existing = this.ctx.storage.sql.exec<{ principal: string; user: string }>(
      `SELECT principal, user FROM principal_aliases WHERE principal = ? OR user = ?`,
      principal, user).toArray();
    if (existing.length === 0) {
      this.ctx.storage.sql.exec(
        `INSERT INTO principal_aliases (principal, user, created_at) VALUES (?, ?, ?)`,
        principal, user, new Date().toISOString());
      return "added";
    }
    return existing.length === 1 && existing[0]!.principal === principal && existing[0]!.user === user
      ? "already-aliased" : "conflict";
  }

  /**
   * Insert or update one user's record. `rev` is the user DO's profile revision: a record already
   * at a higher revision is left alone, so syncs that arrive out of order still converge on the
   * newest profile.
   */
  syncUser(record: UserDirectoryRecord, rev: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, name, search_text, rev) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, search_text = excluded.search_text,
         rev = excluded.rev
       WHERE excluded.rev > users.rev`,
      record.id, record.name, `${record.id}\n${record.name}`.toLowerCase(), rev);
  }

  /**
   * Case-insensitive substring search over name and id, excluding every id in `excludeIds`.
   * The id is indexed first so an exact id starts at position one; ties sort by id then name.
   * Rejects a query over `MAX_QUERY_LENGTH` characters or containing a line break, and more than
   * `MAX_EXCLUDE_IDS` distinct exclusions.
   */
  searchUsers(query: string, excludeIds: string[]): UserDirectoryRecord[] {
    // Name and id are joined by a newline in search_text, so a needle containing one could match
    // across the two fields.
    if (query.length > MAX_QUERY_LENGTH || /[\r\n]/.test(query)) {
      throw new Error(
        `Search query must be at most ${MAX_QUERY_LENGTH} characters with no line breaks.`);
    }
    const excluded = [...new Set(excludeIds)];
    if (excluded.length > MAX_EXCLUDE_IDS) {
      throw new Error(`At most ${MAX_EXCLUDE_IDS} users can be excluded from a search.`);
    }
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    return this.ctx.storage.sql.exec<UserDirectoryRecord>(
      `SELECT id, name FROM users
       WHERE id NOT IN (SELECT value FROM json_each(?)) AND instr(search_text, ?) > 0
       ORDER BY instr(search_text, ?), id, name COLLATE NOCASE
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      JSON.stringify(excluded), needle, needle,
    ).toArray();
  }
}
