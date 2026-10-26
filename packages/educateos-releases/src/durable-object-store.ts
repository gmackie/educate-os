// Durable Object stores for releases (SCHO-85), published as their own entry point
// (`@educateos/releases/durable-object-store`). Like the fleet's, they name the storage they need
// structurally and import nothing from `cloudflare:workers`. Each is meant to sit in the same
// Durable Object as the logic it serves: `DistrictReleaseManager` in the district's own Worker,
// `RolloutController` in the root's. Those serialize their read-modify-write cycles themselves.
import type { InstanceId } from "@educateos/contracts";
import { type ReleaseChannel, Sequence } from "@educateos/fleet";
import { type DurableObjectSqlStorage, DurableObjectTables, parseStoredJson } from "@educateos/fleet/durable-object-store";
import { DistrictReleaseState, type DistrictReleaseStore } from "./district.ts";
import { ChannelState, type RolloutStore } from "./rollout.ts";

/** The district release state's table. Exported so tests and migrations can name it. */
export const DISTRICT_RELEASE_STATE_TABLE = "educateos_release_district_state";

/** The rollout tables. Exported so tests and migrations can name them. */
export const ROLLOUT_TABLES = {
  channels: "educateos_release_channels",
  offerSequences: "educateos_release_offer_sequences",
} as const;

// One row, pinned by the CHECK, holding the whole state as JSON. It is small (trust, install
// history, offers), always read and saved whole, and parsed with its schema on every load.
const DISTRICT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${DISTRICT_RELEASE_STATE_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state_json TEXT NOT NULL
  )`,
];

/**
 * A {@link DistrictReleaseStore} in a SQLite-backed Durable Object. A save replaces the row in one
 * statement, so a crash leaves the previous state or the new one, never a mix; a stored state that
 * no longer parses is refused rather than read as empty, which would forget the district's pinned
 * keys and declines.
 */
export class DurableObjectDistrictReleaseStore implements DistrictReleaseStore {
  readonly #tables: DurableObjectTables;

  constructor(storage: DurableObjectSqlStorage) {
    // The state from before the rename (SCHO-232), unless one has been saved since.
    this.#tables = new DurableObjectTables(storage, DISTRICT_SCHEMA, [{ table: DISTRICT_RELEASE_STATE_TABLE, merge: { kind: "keyed" } }]);
  }

  async load(): Promise<DistrictReleaseState | undefined> {
    const [row] = this.#tables.transact((sql) => sql.exec(`SELECT state_json FROM ${DISTRICT_RELEASE_STATE_TABLE} WHERE id = 1`).toArray());
    return row === undefined ? undefined : parseStoredJson(DistrictReleaseState, row.state_json, "the district release state");
  }

  async save(state: DistrictReleaseState): Promise<void> {
    const json = JSON.stringify(DistrictReleaseState.parse(state));
    this.#tables.transact((sql) =>
      sql.exec(`INSERT INTO ${DISTRICT_RELEASE_STATE_TABLE} (id, state_json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state_json = excluded.state_json`, json));
  }
}

// The offer sequence is one row per instance, bumped in a single statement, so two offers to the
// same instance can never share a number even if two controllers raced.
const ROLLOUT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${ROLLOUT_TABLES.channels} (
    channel TEXT PRIMARY KEY,
    state_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${ROLLOUT_TABLES.offerSequences} (
    instance_id TEXT PRIMARY KEY,
    last INTEGER NOT NULL CHECK (last >= 1)
  )`,
];

/** A {@link RolloutStore} in a SQLite-backed Durable Object, with an atomic per-instance offer sequence. */
export class DurableObjectRolloutStore implements RolloutStore {
  readonly #tables: DurableObjectTables;

  constructor(storage: DurableObjectSqlStorage) {
    // From before the rename (SCHO-232): a channel saved since wins; an offer sequence goes past both.
    this.#tables = new DurableObjectTables(storage, ROLLOUT_SCHEMA, [
      { table: ROLLOUT_TABLES.channels, merge: { kind: "keyed" } },
      { table: ROLLOUT_TABLES.offerSequences, merge: { kind: "revision", key: ["instance_id"], revision: "last" } },
    ]);
  }

  async channel(channel: ReleaseChannel): Promise<ChannelState> {
    const [row] = this.#tables.transact((sql) => sql.exec(`SELECT state_json FROM ${ROLLOUT_TABLES.channels} WHERE channel = ?`, channel).toArray());
    return row === undefined ? { releases: {} } : parseStoredJson(ChannelState, row.state_json, `the ${channel} channel state`);
  }

  async saveChannel(channel: ReleaseChannel, state: ChannelState): Promise<void> {
    const json = JSON.stringify(ChannelState.parse(state));
    this.#tables.transact((sql) =>
      sql.exec(`INSERT INTO ${ROLLOUT_TABLES.channels} (channel, state_json) VALUES (?, ?) ON CONFLICT (channel) DO UPDATE SET state_json = excluded.state_json`, channel, json));
  }

  async nextOfferSequence(instanceId: InstanceId): Promise<number> {
    return this.#tables.transact((sql) => {
      const [row] = sql.exec(
        `INSERT INTO ${ROLLOUT_TABLES.offerSequences} (instance_id, last) VALUES (?, 1)
         ON CONFLICT (instance_id) DO UPDATE SET last = last + 1 RETURNING last`,
        instanceId,
      ).toArray();
      return Sequence.parse(row?.last);
    });
  }
}
