// The control plane's state: who has signed in, and the installations each operator made through
// educateos.io. It lives in one SQLite-backed Durable Object rather than D1: the repository's other
// stores are Durable Objects built on the same helpers, a deploy then needs nothing beyond
// `wrangler deploy` (no separate migration step or database permission in the deployer's token),
// and a single writer makes a slug's uniqueness and the registry's first-come writes atomic.
//
// It holds no district data. An installation row is what the operator chose and where it lives;
// the installation itself runs in the operator's own Cloudflare account and never calls back here
// unless it opted in to the registry (ADR-0013).
import { CommercialAccountId } from "@educateos/contracts";
import { DurableObjectTables, parseStoredJson, type DurableObjectSqlStorage } from "@educateos/fleet/durable-object-store";
import { z } from "zod";
import type { OperatorIdentity } from "./access.ts";

/** An operator: a person who signed in to educateos.io/app. */
export interface Operator {
  /** Access's stable user ID, the operator's key. */
  subject: string;
  /**
   * The operator's account, `acct_…`: the ID other systems know them by (an opted-in
   * installation's registry record, and later billing), so the Access subject never leaves here.
   */
  accountId: CommercialAccountId;
  /** The email Access last verified for them. */
  email: string;
  /** When they first signed in, ISO 8601. */
  firstSeenAt: string;
  /** When they were last seen signed in, ISO 8601, to within {@link LAST_SEEN_RESOLUTION_MS}. */
  lastSeenAt: string;
}

/** An installation an operator made through educateos.io. */
export const Installation = z.strictObject({
  /** The installer's instance ID, `ins_…`. */
  instanceId: z.string().regex(/^ins_[a-z0-9]{1,20}$/),
  /** The managed slug, so the installation serves at `<slug>.educateos.io`. */
  slug: z.string().min(3).max(32),
  /** The hostname the installation serves at. */
  hostname: z.string().min(1).max(253),
  /** The operator's Cloudflare account it was installed into. */
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  /** The release version it was installed at. */
  releaseVersion: z.string().min(1).max(64),
  /** When the install finished, ISO 8601. */
  installedAt: z.iso.datetime(),
});
/** An installation an operator made through educateos.io. */
export type Installation = z.infer<typeof Installation>;

/** The tables, exported so tests and later migrations can name them. */
export const TABLES = { operators: "control_plane_operators", installations: "control_plane_installations" } as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${TABLES.operators} (
    subject TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  // A slug names one installation at a time, across every operator.
  `CREATE TABLE IF NOT EXISTS ${TABLES.installations} (
    instance_id TEXT PRIMARY KEY,
    operator_subject TEXT NOT NULL REFERENCES ${TABLES.operators} (subject),
    slug TEXT NOT NULL UNIQUE,
    record TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${TABLES.installations}_by_operator ON ${TABLES.installations} (operator_subject)`,
];

const OperatorRow = z.object({
  subject: z.string(),
  account_id: CommercialAccountId,
  email: z.string(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});

/**
 * How stale an operator's `lastSeenAt` may get before a request refreshes it. Each console request
 * signs the operator in again, and this keeps that from being a write to the one global object
 * every time.
 */
export const LAST_SEEN_RESOLUTION_MS = 60 * 60 * 1000;

const OPERATOR_COLUMNS = "subject, account_id, email, first_seen_at, last_seen_at";

/** A new operator account ID: 128 random bits. */
function newAccountId(): CommercialAccountId {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return CommercialAccountId.parse(`acct_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`);
}

/** The control plane's store, over a SQLite-backed Durable Object's storage. */
export class ControlPlaneStore {
  readonly #tables: DurableObjectTables;
  readonly #now: () => Date;

  constructor(storage: DurableObjectSqlStorage, now: () => Date = () => new Date()) {
    this.#tables = new DurableObjectTables(storage, SCHEMA);
    this.#now = now;
  }

  /**
   * Records a sign-in: creates the operator on their first, and keeps their email current. A
   * returning operator's row is written only when their email changed or `lastSeenAt` is older than
   * {@link LAST_SEEN_RESOLUTION_MS}.
   */
  signIn(identity: OperatorIdentity): Operator {
    const now = this.#now();
    const at = now.toISOString();
    const stale = new Date(now.getTime() - LAST_SEEN_RESOLUTION_MS).toISOString();
    return this.#tables.transact((sql) => {
      const [written] = sql.exec(
        `INSERT INTO ${TABLES.operators} (${OPERATOR_COLUMNS}) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (subject) DO UPDATE SET email = excluded.email, last_seen_at = excluded.last_seen_at
           WHERE email <> excluded.email OR last_seen_at < ?
         RETURNING ${OPERATOR_COLUMNS}`,
        identity.subject, newAccountId(), identity.email, at, at, stale,
      ).toArray();
      const row = written ?? sql.exec(`SELECT ${OPERATOR_COLUMNS} FROM ${TABLES.operators} WHERE subject = ?`, identity.subject).toArray()[0];
      const parsed = OperatorRow.parse(row);
      return {
        subject: parsed.subject,
        accountId: parsed.account_id,
        email: parsed.email,
        firstSeenAt: parsed.first_seen_at,
        lastSeenAt: parsed.last_seen_at,
      };
    });
  }

  /** The operator's installations, newest first. */
  installations(operatorSubject: string): Installation[] {
    return this.#tables.transact((sql) =>
      sql.exec(`SELECT instance_id, record FROM ${TABLES.installations} WHERE operator_subject = ?`, operatorSubject)
        .toArray()
        .map((row) => parseStoredJson(Installation, row.record, `installation ${String(row.instance_id)}`))
        .toSorted((a, b) => b.installedAt.localeCompare(a.installedAt)));
  }

  /** Answers once the store can read and write, for the site's health check. */
  ping(): true {
    this.#tables.transact((sql) => sql.exec("SELECT 1").toArray());
    return true;
  }
}
