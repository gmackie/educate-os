// The Durable Object implementation of `CatalogMirrorStorage` (SCHO-64), published as its own entry
// point (`@educateos/catalog/durable-object-storage`). It names the storage it needs structurally
// and imports nothing from `cloudflare:workers`, so the package's main entry stays runtime-agnostic
// and the district Worker that hosts the mirror chooses its own Durable Object class around it.
import { EducateOsError } from "@educateos/contracts";
import { FrameworkRelease } from "@educateos/registry";
import { z } from "zod";
import { contentDigest } from "./digest.ts";
import { type CatalogMirrorStorage, FrameworkMirrorState, InstalledRelease } from "./mirror.ts";
import { CatalogRelease } from "./release.ts";
import type { CatalogKey } from "./vocabulary.ts";

/** A value SQLite stores in one column. */
export type MirrorSqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the store uses: synchronous SQL and
 * synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 */
export interface MirrorSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: MirrorSqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The table each framework's state is kept in, without release content. */
export const CATALOG_MIRROR_STATE_TABLE = "educateos_catalog_mirror_states";
/** The table release content is kept in, by content digest, split into chunks. */
export const CATALOG_MIRROR_CONTENT_TABLE = "educateos_catalog_mirror_content";

// A Durable Object row holds at most 2 MB, and one TEKS chapter alone is several. So a release's
// content is stored once per digest, in chunks of at most 1 MB of UTF-8, and a state row names it
// by digest. `revision` copies what the state JSON holds, so the compare-and-swap is checked
// without parsing; the JSON is what is trusted.
const CHUNK_CHARS = 256 * 1024;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${CATALOG_MIRROR_STATE_TABLE} (
    framework_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    state_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${CATALOG_MIRROR_CONTENT_TABLE} (
    content_digest TEXT NOT NULL,
    seq INTEGER NOT NULL,
    chunk TEXT NOT NULL,
    PRIMARY KEY (content_digest, seq)
  )`,
];

/** An installed release as a state row keeps it: everything but the content, which is named by digest. */
const StoredInstalledRelease = InstalledRelease.extend({ release: CatalogRelease.omit({ content: true }) });
const StoredState = FrameworkMirrorState.extend({ releases: z.array(StoredInstalledRelease) });
type StoredState = z.infer<typeof StoredState>;

const StateRow = z.object({ framework_key: z.string(), revision: z.number(), state_json: z.string() });
const ChunkRow = z.object({ chunk: z.string() });

/** Thrown when stored state cannot be read. The mirror refuses to act on state it cannot read. */
export class CatalogMirrorCorruptionError extends Error {
  override readonly name = "CatalogMirrorCorruptionError";
}

const json = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new CatalogMirrorCorruptionError(`${what} is not JSON`);
  }
};

/**
 * A {@link CatalogMirrorStorage} in a SQLite-backed Durable Object's storage. One Durable Object
 * holds one district's mirror.
 *
 * `put` checks the stored revision and writes the new state inside one `transactionSync`, with no
 * `await` between them, so two writers that read the same revision cannot both commit: the object
 * runs one synchronous block at a time, and the second finds the revision already moved and gets
 * `conflict`. Content no state names any more is deleted in the same transaction.
 *
 * Reads are checked as hard as writes: a state row must match its key and revision, and release
 * content must hash to the digest the state names, or the read fails with
 * {@link CatalogMirrorCorruptionError}.
 */
export class DurableObjectCatalogMirrorStorage implements CatalogMirrorStorage {
  readonly #storage: MirrorSqlStorage;

  constructor(storage: MirrorSqlStorage) {
    this.#storage = storage;
    for (const statement of SCHEMA) storage.sql.exec(statement);
  }

  async get(key: CatalogKey): Promise<FrameworkMirrorState | undefined> {
    const [row] = this.#storage.sql.exec(`SELECT * FROM ${CATALOG_MIRROR_STATE_TABLE} WHERE framework_key = ?`, key).toArray();
    return row === undefined ? undefined : this.#hydrate(this.#parseState(row));
  }

  async list(): Promise<FrameworkMirrorState[]> {
    const rows = this.#storage.sql.exec(`SELECT * FROM ${CATALOG_MIRROR_STATE_TABLE} ORDER BY framework_key`).toArray();
    return Promise.all(rows.map((row) => this.#hydrate(this.#parseState(row))));
  }

  async put(state: FrameworkMirrorState): Promise<void> {
    const parsed = FrameworkMirrorState.safeParse(state);
    if (!parsed.success) throw new EducateOsError("validation-failed", "not a framework mirror state");
    const next = parsed.data;
    // Hashing is asynchronous, so it happens before the transaction; the revision check inside it
    // is what decides whether this write wins.
    const contents = new Map<string, string>();
    for (const { release } of next.releases) {
      if ((await contentDigest(release.content)) !== release.contentDigest) {
        throw new EducateOsError("validation-failed", `release ${release.frameworkKey}@${release.version} does not match its digest`);
      }
      contents.set(release.contentDigest, JSON.stringify(release.content));
    }
    const stored: StoredState = {
      ...next,
      releases: next.releases.map(({ release: { content: _, ...header }, ...installed }) => ({ ...installed, release: header })),
    };

    const { sql } = this.#storage;
    this.#storage.transactionSync(() => {
      const [row] = sql.exec(`SELECT revision FROM ${CATALOG_MIRROR_STATE_TABLE} WHERE framework_key = ?`, next.frameworkKey).toArray();
      if ((row === undefined ? 0 : Number(row["revision"])) !== next.revision - 1) {
        throw new EducateOsError("conflict", `${next.frameworkKey} changed since it was read`);
      }
      for (const [digest, text] of contents) {
        if (sql.exec(`SELECT 1 FROM ${CATALOG_MIRROR_CONTENT_TABLE} WHERE content_digest = ? LIMIT 1`, digest).toArray().length > 0) continue;
        for (let seq = 0; seq * CHUNK_CHARS < text.length; seq++) {
          sql.exec(
            `INSERT INTO ${CATALOG_MIRROR_CONTENT_TABLE} (content_digest, seq, chunk) VALUES (?, ?, ?)`,
            digest,
            seq,
            text.slice(seq * CHUNK_CHARS, (seq + 1) * CHUNK_CHARS),
          );
        }
      }
      sql.exec(
        `INSERT INTO ${CATALOG_MIRROR_STATE_TABLE} (framework_key, revision, state_json) VALUES (?, ?, ?)
         ON CONFLICT (framework_key) DO UPDATE SET revision = excluded.revision, state_json = excluded.state_json`,
        next.frameworkKey,
        next.revision,
        JSON.stringify(stored),
      );
      this.#collectUnreferencedContent();
    });
  }

  #parseState(raw: Record<string, unknown>): StoredState {
    const row = StateRow.safeParse(raw);
    if (!row.success) throw new CatalogMirrorCorruptionError("a catalog mirror row has an unexpected shape");
    const state = StoredState.safeParse(json(row.data.state_json, `the mirror state for ${row.data.framework_key}`));
    if (!state.success || state.data.frameworkKey !== row.data.framework_key || state.data.revision !== row.data.revision) {
      throw new CatalogMirrorCorruptionError(`the mirror state for ${row.data.framework_key} does not match its key and revision`);
    }
    return state.data;
  }

  async #hydrate(state: StoredState): Promise<FrameworkMirrorState> {
    const releases = await Promise.all(state.releases.map(async (installed) => {
      const digest = installed.release.contentDigest;
      const chunks = this.#storage.sql
        .exec(`SELECT chunk FROM ${CATALOG_MIRROR_CONTENT_TABLE} WHERE content_digest = ? ORDER BY seq`, digest)
        .toArray();
      const text = chunks.map((chunk) => {
        const parsed = ChunkRow.safeParse(chunk);
        if (!parsed.success) throw new CatalogMirrorCorruptionError(`content ${digest} has an unreadable chunk`);
        return parsed.data.chunk;
      }).join("");
      const content = FrameworkRelease.safeParse(json(text, `content ${digest}`));
      if (chunks.length === 0 || !content.success || (await contentDigest(content.data)) !== digest) {
        throw new CatalogMirrorCorruptionError(`content ${digest} is missing or does not match its digest`);
      }
      return { ...installed, release: { ...installed.release, content: content.data } };
    }));
    return FrameworkMirrorState.parse({ ...state, releases });
  }

  /** Deletes content that no stored state names. Runs inside `put`'s transaction. */
  #collectUnreferencedContent(): void {
    const referenced = new Set<string>();
    for (const row of this.#storage.sql.exec(`SELECT * FROM ${CATALOG_MIRROR_STATE_TABLE}`).toArray()) {
      for (const { release } of this.#parseState(row).releases) referenced.add(release.contentDigest);
    }
    for (const row of this.#storage.sql.exec(`SELECT DISTINCT content_digest FROM ${CATALOG_MIRROR_CONTENT_TABLE}`).toArray()) {
      const digest = String(row["content_digest"]);
      if (!referenced.has(digest)) this.#storage.sql.exec(`DELETE FROM ${CATALOG_MIRROR_CONTENT_TABLE} WHERE content_digest = ?`, digest);
    }
  }
}
