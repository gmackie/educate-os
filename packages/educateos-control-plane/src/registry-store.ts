// The opt-in instance registry's storage (SCHO-155's Durable Object `InstanceRegistryStorage`), in
// the control plane's Durable Object. `@educateos/fleet`'s `InstanceRegistry` holds the protocol:
// signatures, freshness, sequence numbers and ownership tokens. This file only makes its writes
// atomic, which is what keeps registration first-come and every sequence number and key single-use.
//
// An installation that never opts in has no row here, and one that does sends only the protocol's
// fixed, content-free fields (ADR-0013): its ID and key, a label, its release version, capabilities,
// a contact role, the operator's account ID and probe status codes.
import { CommercialAccountId, InstanceId } from "@educateos/contracts";
import { DurableObjectTables, parseStoredJson, type DurableObjectSqlStorage } from "@educateos/fleet/durable-object-store";
import type { InstanceRecord, InstanceRegistryStorage, KeyId, KeyReplacement } from "@educateos/fleet";
import { z } from "zod";

/** The registry's tables, exported so tests and later migrations can name them. */
export const REGISTRY_TABLES = {
  instances: "control_plane_registry_instances",
  keys: "control_plane_registry_keys",
} as const;

const SCHEMA = [
  // The record is the fleet's `InstanceRecord` as JSON. The columns beside it are the ones writes
  // are conditioned on, and the account an operator's dashboard reads by.
  `CREATE TABLE IF NOT EXISTS ${REGISTRY_TABLES.instances} (
    instance_id TEXT PRIMARY KEY,
    key_id TEXT NOT NULL,
    commercial_account_id TEXT NOT NULL,
    last_sequence INTEGER NOT NULL,
    record TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${REGISTRY_TABLES.instances}_by_account ON ${REGISTRY_TABLES.instances} (commercial_account_id)`,
  // Every key ever registered, current or retired. None is accepted twice, for any instance.
  `CREATE TABLE IF NOT EXISTS ${REGISTRY_TABLES.keys} (key_id TEXT PRIMARY KEY)`,
];

// What a stored record must hold for the store to act on it. The registry wrote the rest, and it is
// returned as stored.
const StoredRecord = z.looseObject({
  instanceId: InstanceId,
  keyId: z.string().min(1),
  commercialAccountId: CommercialAccountId,
  lastSequence: z.number().int().min(0),
  ownershipTokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  retiredKeyIds: z.array(z.string()),
});

type Sql = DurableObjectSqlStorage["sql"];

function read(row: Record<string, unknown> | undefined): InstanceRecord | undefined {
  if (row === undefined) return undefined;
  return parseStoredJson(StoredRecord, row.record, `registry record ${String(row.instance_id)}`) as unknown as InstanceRecord;
}

function keyKnown(sql: Sql, keyId: KeyId): boolean {
  return sql.exec(`SELECT 1 FROM ${REGISTRY_TABLES.keys} WHERE key_id = ?`, keyId).toArray().length > 0;
}

function select(sql: Sql, instanceId: string): InstanceRecord | undefined {
  return read(sql.exec(`SELECT instance_id, record FROM ${REGISTRY_TABLES.instances} WHERE instance_id = ?`, instanceId).toArray()[0]);
}

/** An {@link InstanceRegistryStorage} in a SQLite-backed Durable Object. */
export class DurableObjectRegistryStorage implements InstanceRegistryStorage {
  readonly #tables: DurableObjectTables;

  constructor(storage: DurableObjectSqlStorage) {
    this.#tables = new DurableObjectTables(storage, SCHEMA);
  }

  async get(instanceId: InstanceRecord["instanceId"]): Promise<InstanceRecord | undefined> {
    return this.#tables.transact((sql) => select(sql, instanceId));
  }

  async insert(record: InstanceRecord): Promise<boolean> {
    return this.#tables.transact((sql) => {
      if (select(sql, record.instanceId) !== undefined || keyKnown(sql, record.keyId)) return false;
      sql.exec(
        `INSERT INTO ${REGISTRY_TABLES.instances} (instance_id, key_id, commercial_account_id, last_sequence, record) VALUES (?, ?, ?, ?, ?)`,
        record.instanceId, record.keyId, record.commercialAccountId, record.lastSequence, JSON.stringify(record),
      );
      sql.exec(`INSERT INTO ${REGISTRY_TABLES.keys} (key_id) VALUES (?)`, record.keyId);
      return true;
    });
  }

  async replaceKey(
    instanceId: InstanceRecord["instanceId"],
    next: KeyReplacement,
    expected: { keyId: KeyId; ownershipTokenSha256: string },
  ): Promise<InstanceRecord | undefined> {
    return this.#tables.transact((sql) => {
      const stored = select(sql, instanceId);
      if (
        stored?.keyId !== expected.keyId ||
        stored.ownershipTokenSha256 !== expected.ownershipTokenSha256 ||
        keyKnown(sql, next.keyId)
      ) {
        return undefined;
      }
      const record: InstanceRecord = { ...stored, ...next, retiredKeyIds: [...stored.retiredKeyIds, stored.keyId] };
      sql.exec(`UPDATE ${REGISTRY_TABLES.instances} SET key_id = ?, record = ? WHERE instance_id = ?`,
        record.keyId, JSON.stringify(record), instanceId);
      sql.exec(`INSERT INTO ${REGISTRY_TABLES.keys} (key_id) VALUES (?)`, next.keyId);
      return record;
    });
  }

  async update(record: InstanceRecord, expectedLastSequence: number): Promise<boolean> {
    return this.#tables.transact((sql) => {
      // The record's account is fixed at registration, so an update can't move it to another
      // operator. This is stricter than fleet's in-memory reference, which doesn't check it.
      const changed = sql.exec(
        `UPDATE ${REGISTRY_TABLES.instances} SET last_sequence = ?, record = ?
         WHERE instance_id = ? AND last_sequence = ? AND key_id = ? AND commercial_account_id = ?
         RETURNING instance_id`,
        record.lastSequence, JSON.stringify(record), record.instanceId, expectedLastSequence, record.keyId, record.commercialAccountId,
      ).toArray();
      return changed.length === 1;
    });
  }

  async list(): Promise<InstanceRecord[]> {
    return this.#tables.transact((sql) =>
      sql.exec(`SELECT instance_id, record FROM ${REGISTRY_TABLES.instances}`).toArray().map((row) => read(row)!));
  }

  /** The records registered under one operator account. */
  async forAccount(accountId: CommercialAccountId): Promise<InstanceRecord[]> {
    return this.#tables.transact((sql) =>
      sql.exec(`SELECT instance_id, record FROM ${REGISTRY_TABLES.instances} WHERE commercial_account_id = ?`, accountId)
        .toArray().map((row) => read(row)!));
  }
}
