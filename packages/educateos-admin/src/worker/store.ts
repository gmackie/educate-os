// The admin's D1 store (SCHO-263). Plain SQL over the schema in migrations/: operators, workspaces,
// ops keys, analytics snapshots and the audit log. Nothing a district passes through (directory or
// device data) has a table or a method here, and that is deliberate.
import type { AnalyticsRange } from "@educateos/fleet/ops";
import type {
  AuditEntry, AuditPage, Edition, InstallationRecord, InstallationsResponse, OperatorRole, SlugReservationRecord, Workspace, WorkspaceStatus,
} from "../shared/api.ts";

/** A workspace's current key row. */
export interface OpsKeyRow {
  workspaceId: string;
  keyId: string;
  publicJwk: string;
  sealedPrivateKey: string;
  createdAt: string;
}

/** A cached analytics report. */
export interface SnapshotRow {
  json: string;
  fetchedAt: string;
}

/** One audit record to write. */
export interface AuditRecord {
  operatorSub: string;
  workspaceId?: string;
  action: string;
  target?: string;
  result: string;
  at: string;
}

interface WorkspaceRecord {
  id: string;
  slug: string;
  display_name: string;
  origin: string;
  edition: Edition;
  enrolled_at: string;
  status: WorkspaceStatus;
}

const toWorkspace = (row: WorkspaceRecord): Workspace => ({
  id: row.id,
  slug: row.slug,
  displayName: row.display_name,
  origin: row.origin,
  edition: row.edition,
  enrolledAt: row.enrolled_at,
  status: row.status,
});

/** An operator as the control-plane import compares it. */
export interface OperatorImportRow {
  sub: string;
  accountId?: string;
  firstSeenAt: string;
}

/** An installation row (migrations/0002). */
export interface InstallationRow {
  instanceId: string;
  workspaceId?: string;
  operatorSub: string;
  slug: string;
  hostname: string;
  cloudflareAccountId: string;
  releaseVersion: string;
  installedAt: string;
  importedAt: string;
}

/** A slug reservation row (migrations/0002). */
export interface ReservationRow {
  slug: string;
  operatorSub: string;
  cloudflareAccountId: string;
  instanceId: string;
  leaseUntil?: string;
  importedAt: string;
}

/** Everything one control-plane import writes, applied in one D1 batch. */
export interface ImportWrites {
  newOperators: { sub: string; email: string; accountId: string; firstSeenAt: string; lastSeenAt: string }[];
  /** Existing operators: their account ID, and the earlier of the two first-seen times. */
  operatorAccounts: { sub: string; accountId: string; firstSeenAt: string }[];
  workspaces: { workspace: Workspace; key: OpsKeyRow }[];
  installations: InstallationRow[];
  reservations: ReservationRow[];
  removedReservations: string[];
}

interface InstallationRecordRow {
  instance_id: string;
  workspace_id: string | null;
  operator_sub: string;
  slug: string;
  hostname: string;
  cloudflare_account_id: string;
  release_version: string;
  installed_at: string;
  imported_at: string;
}

interface ReservationRecordRow {
  slug: string;
  operator_sub: string;
  cloudflare_account_id: string;
  instance_id: string;
  lease_until: string | null;
  imported_at: string;
}

const toInstallationRow = (row: InstallationRecordRow): InstallationRow => ({
  instanceId: row.instance_id,
  ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
  operatorSub: row.operator_sub,
  slug: row.slug,
  hostname: row.hostname,
  cloudflareAccountId: row.cloudflare_account_id,
  releaseVersion: row.release_version,
  installedAt: row.installed_at,
  importedAt: row.imported_at,
});

const toReservationRow = (row: ReservationRecordRow): ReservationRow => ({
  slug: row.slug,
  operatorSub: row.operator_sub,
  cloudflareAccountId: row.cloudflare_account_id,
  instanceId: row.instance_id,
  ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
  importedAt: row.imported_at,
});

/** How long a signed-in operator's last-seen time may lag. Saves a write per request. */
export const LAST_SEEN_RESOLUTION_MS = 60 * 60 * 1000;

/** The audit log's page size. */
export const AUDIT_PAGE_SIZE = 50;

/** The admin's D1 store. */
export class AdminStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** Records a signed-in operator, refreshing email, role and last-seen (at most hourly). */
  async recordOperator(sub: string, email: string, role: OperatorRole, at: Date): Promise<void> {
    const now = at.toISOString();
    const stale = new Date(at.getTime() - LAST_SEEN_RESOLUTION_MS).toISOString();
    await this.#db.prepare(
      `INSERT INTO operators (sub, email, role, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (sub) DO UPDATE SET email = excluded.email, role = excluded.role, last_seen_at = excluded.last_seen_at
       WHERE operators.email <> excluded.email OR operators.role <> excluded.role OR operators.last_seen_at < ?5`,
    ).bind(sub, email, role, now, stale).run();
  }

  /** Every workspace that isn't removed, by display name. */
  async workspaces(): Promise<Workspace[]> {
    const { results } = await this.#db.prepare(
      "SELECT * FROM workspaces WHERE status <> 'removed' ORDER BY display_name COLLATE NOCASE, slug",
    ).all<WorkspaceRecord>();
    return results.map(toWorkspace);
  }

  /** One workspace, removed or not. */
  async workspace(id: string): Promise<Workspace | undefined> {
    const row = await this.#db.prepare("SELECT * FROM workspaces WHERE id = ?1").bind(id).first<WorkspaceRecord>();
    return row === null ? undefined : toWorkspace(row);
  }

  /** Whether a live workspace already has this slug or origin. */
  async conflicting(slug: string, origin: string): Promise<boolean> {
    const row = await this.#db.prepare("SELECT 1 FROM workspaces WHERE slug = ?1 OR origin = ?2").bind(slug, origin).first();
    return row !== null;
  }

  /** Enrolls a workspace with its first key, in one batch. */
  async enroll(workspace: Workspace, key: OpsKeyRow): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(
        "INSERT INTO workspaces (id, slug, display_name, origin, edition, enrolled_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).bind(workspace.id, workspace.slug, workspace.displayName, workspace.origin, workspace.edition, workspace.enrolledAt, workspace.status),
      this.#db.prepare(
        "INSERT INTO ops_keys (workspace_id, key_id, public_jwk, private_key_ciphertext, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(key.workspaceId, key.keyId, key.publicJwk, key.sealedPrivateKey, key.createdAt),
    ]);
  }

  /** Sets a workspace's status. */
  async setStatus(id: string, status: WorkspaceStatus): Promise<void> {
    await this.#db.prepare("UPDATE workspaces SET status = ?2 WHERE id = ?1").bind(id, status).run();
  }

  /**
   * Removes a workspace from this admin: marks it removed, retires its keys and drops its cached
   * analytics. The audit log keeps its entries. A removed workspace's slug and origin stay taken;
   * enroll it again under a new slug, or delete the row by hand.
   */
  async remove(id: string, at: Date): Promise<void> {
    await this.#db.batch([
      this.#db.prepare("UPDATE workspaces SET status = 'removed' WHERE id = ?1").bind(id),
      this.#db.prepare("UPDATE ops_keys SET retired_at = ?2 WHERE workspace_id = ?1 AND retired_at IS NULL").bind(id, at.toISOString()),
      this.#db.prepare("DELETE FROM analytics_snapshots WHERE workspace_id = ?1").bind(id),
    ]);
  }

  /** A workspace's current (unretired) key. */
  async activeKey(workspaceId: string): Promise<OpsKeyRow | undefined> {
    const row = await this.#db.prepare(
      "SELECT workspace_id, key_id, public_jwk, private_key_ciphertext, created_at FROM ops_keys WHERE workspace_id = ?1 AND retired_at IS NULL",
    ).bind(workspaceId).first<{ workspace_id: string; key_id: string; public_jwk: string; private_key_ciphertext: string; created_at: string }>();
    return row === null
      ? undefined
      : { workspaceId: row.workspace_id, keyId: row.key_id, publicJwk: row.public_jwk, sealedPrivateKey: row.private_key_ciphertext, createdAt: row.created_at };
  }

  /** The cached analytics for a workspace and window. */
  async snapshot(workspaceId: string, range: AnalyticsRange): Promise<SnapshotRow | undefined> {
    const row = await this.#db.prepare(
      "SELECT aggregates_json, fetched_at FROM analytics_snapshots WHERE workspace_id = ?1 AND time_range = ?2",
    ).bind(workspaceId, range).first<{ aggregates_json: string; fetched_at: string }>();
    return row === null ? undefined : { json: row.aggregates_json, fetchedAt: row.fetched_at };
  }

  /** Stores analytics aggregates, replacing the previous snapshot. */
  async putSnapshot(workspaceId: string, range: AnalyticsRange, json: string, fetchedAt: string): Promise<void> {
    await this.#db.prepare(
      `INSERT INTO analytics_snapshots (workspace_id, time_range, aggregates_json, fetched_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (workspace_id, time_range) DO UPDATE SET aggregates_json = excluded.aggregates_json, fetched_at = excluded.fetched_at`,
    ).bind(workspaceId, range, json, fetchedAt).run();
  }

  /** Answers once D1 does, for /healthz. */
  async ping(): Promise<void> {
    await this.#db.prepare("SELECT 1").first();
  }

  /** Every workspace, removed ones included, for the import's slug and origin checks. */
  async allWorkspaces(): Promise<Workspace[]> {
    const { results } = await this.#db.prepare("SELECT * FROM workspaces").all<WorkspaceRecord>();
    return results.map(toWorkspace);
  }

  /** Every operator's subject, account ID and first sign-in. */
  async operatorImportRows(): Promise<OperatorImportRow[]> {
    const { results } = await this.#db.prepare("SELECT sub, account_id, first_seen_at FROM operators")
      .all<{ sub: string; account_id: string | null; first_seen_at: string }>();
    return results.map((row) => ({ sub: row.sub, ...(row.account_id === null ? {} : { accountId: row.account_id }), firstSeenAt: row.first_seen_at }));
  }

  /** Every installation row. */
  async installationRows(): Promise<InstallationRow[]> {
    const { results } = await this.#db.prepare("SELECT * FROM installations").all<InstallationRecordRow>();
    return results.map(toInstallationRow);
  }

  /** Every slug reservation row. */
  async reservationRows(): Promise<ReservationRow[]> {
    const { results } = await this.#db.prepare("SELECT * FROM slug_reservations").all<ReservationRecordRow>();
    return results.map(toReservationRow);
  }

  /** Writes one import, all or nothing. */
  async applyImport(writes: ImportWrites): Promise<void> {
    const statements: D1PreparedStatement[] = [
      ...writes.newOperators.map((op) => this.#db.prepare(
        "INSERT INTO operators (sub, email, role, account_id, first_seen_at, last_seen_at) VALUES (?1, ?2, 'installer', ?3, ?4, ?5)",
      ).bind(op.sub, op.email, op.accountId, op.firstSeenAt, op.lastSeenAt)),
      ...writes.operatorAccounts.map((op) => this.#db.prepare(
        "UPDATE operators SET account_id = ?2, first_seen_at = min(first_seen_at, ?3) WHERE sub = ?1",
      ).bind(op.sub, op.accountId, op.firstSeenAt)),
      ...writes.workspaces.flatMap(({ workspace, key }) => [
        this.#db.prepare(
          "INSERT INTO workspaces (id, slug, display_name, origin, edition, enrolled_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        ).bind(workspace.id, workspace.slug, workspace.displayName, workspace.origin, workspace.edition, workspace.enrolledAt, workspace.status),
        this.#db.prepare(
          "INSERT INTO ops_keys (workspace_id, key_id, public_jwk, private_key_ciphertext, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ).bind(key.workspaceId, key.keyId, key.publicJwk, key.sealedPrivateKey, key.createdAt),
      ]),
      ...writes.installations.map((row) => this.#db.prepare(
        `INSERT INTO installations (instance_id, workspace_id, operator_sub, slug, hostname, cloudflare_account_id, release_version, installed_at, imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (instance_id) DO UPDATE SET workspace_id = excluded.workspace_id, operator_sub = excluded.operator_sub, slug = excluded.slug,
           hostname = excluded.hostname, cloudflare_account_id = excluded.cloudflare_account_id, release_version = excluded.release_version,
           installed_at = excluded.installed_at, imported_at = excluded.imported_at`,
      ).bind(row.instanceId, row.workspaceId ?? null, row.operatorSub, row.slug, row.hostname, row.cloudflareAccountId, row.releaseVersion, row.installedAt, row.importedAt)),
      ...writes.removedReservations.map((slug) => this.#db.prepare("DELETE FROM slug_reservations WHERE slug = ?1").bind(slug)),
      ...writes.reservations.map((row) => this.#db.prepare(
        `INSERT INTO slug_reservations (slug, operator_sub, cloudflare_account_id, instance_id, lease_until, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (slug) DO UPDATE SET operator_sub = excluded.operator_sub, cloudflare_account_id = excluded.cloudflare_account_id,
           instance_id = excluded.instance_id, lease_until = excluded.lease_until, imported_at = excluded.imported_at`,
      ).bind(row.slug, row.operatorSub, row.cloudflareAccountId, row.instanceId, row.leaseUntil ?? null, row.importedAt)),
    ];
    if (statements.length > 0) await this.#db.batch(statements);
  }

  /** The installations and reservations, newest first, with the installing operator's email. */
  async installations(): Promise<InstallationsResponse> {
    const [installations, reservations] = await this.#db.batch<Record<string, string | null>>([
      this.#db.prepare(
        `SELECT i.*, o.email AS operator_email FROM installations i LEFT JOIN operators o ON o.sub = i.operator_sub
         ORDER BY i.installed_at DESC, i.instance_id`,
      ),
      this.#db.prepare(
        "SELECT r.*, o.email AS operator_email FROM slug_reservations r LEFT JOIN operators o ON o.sub = r.operator_sub ORDER BY r.slug",
      ),
    ]);
    return {
      installations: (installations!.results as unknown as (InstallationRecordRow & { operator_email: string | null })[]).map((row): InstallationRecord => {
        const { operatorSub: _sub, ...rest } = toInstallationRow(row);
        return { ...rest, ...(row.operator_email === null ? {} : { installedBy: row.operator_email }) };
      }),
      reservations: (reservations!.results as unknown as (ReservationRecordRow & { operator_email: string | null })[]).map((row): SlugReservationRecord => ({
        slug: row.slug,
        instanceId: row.instance_id,
        ...(row.operator_email === null ? {} : { reservedBy: row.operator_email }),
        cloudflareAccountId: row.cloudflare_account_id,
        ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
      })),
    };
  }

  /** Appends to the audit log. */
  async audit(record: AuditRecord): Promise<void> {
    await this.#db.prepare(
      "INSERT INTO audit_log (operator_sub, workspace_id, action, target, result, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(record.operatorSub, record.workspaceId ?? null, record.action, record.target ?? null, record.result, record.at).run();
  }

  /** The audit log, newest first, optionally for one workspace. The cursor is the last entry's ID. */
  async auditPage(options: { workspaceId?: string; before?: number }): Promise<AuditPage> {
    const { results } = await this.#db.prepare(
      `SELECT a.id, a.at, a.operator_sub, o.email AS operator_email, a.workspace_id, a.action, a.target, a.result
       FROM audit_log a LEFT JOIN operators o ON o.sub = a.operator_sub
       WHERE (?1 IS NULL OR a.workspace_id = ?1) AND (?2 IS NULL OR a.id < ?2)
       ORDER BY a.id DESC LIMIT ?3`,
    ).bind(options.workspaceId ?? null, options.before ?? null, AUDIT_PAGE_SIZE + 1).all<{
      id: number; at: string; operator_sub: string; operator_email: string | null; workspace_id: string | null;
      action: string; target: string | null; result: string;
    }>();
    const entries: AuditEntry[] = results.slice(0, AUDIT_PAGE_SIZE).map((row) => ({
      id: row.id,
      at: row.at,
      operatorSub: row.operator_sub,
      ...(row.operator_email === null ? {} : { operatorEmail: row.operator_email }),
      ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
      action: row.action,
      ...(row.target === null ? {} : { target: row.target }),
      result: row.result,
    }));
    const last = entries.at(-1);
    return results.length > AUDIT_PAGE_SIZE && last !== undefined ? { entries, nextCursor: String(last.id) } : { entries };
  }
}
