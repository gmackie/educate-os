import { z } from "zod";
import { UtcTimestamp } from "@educateos/contracts";
import {
  createToolKeySet,
  generateToolKey,
  importToolKey,
  StoredToolKey,
  type Clock,
  type ToolKeySet,
} from "@educateos/lti";
import { LtiStoredRecordError } from "./stores.ts";
import type { RecordTable } from "./table.ts";

/** The collection the district's tool keys are kept in, under {@link TOOL_KEYS_RECORD}. */
export const TOOL_KEYS_COLLECTION = "lti.tool-keys";
/** The one record in {@link TOOL_KEYS_COLLECTION}: the whole key set, written in one step. */
export const TOOL_KEYS_RECORD = "current";

/**
 * How many retired public keys stay published after a rotation. One is enough for a platform to
 * verify a deep linking response or client assertion signed just before the rotation; platforms
 * cache a tool's JWKS for minutes, not days.
 */
export const DEFAULT_RETIRED_KEYS = 1;

/**
 * The district's tool keys as stored: private JWKs, so this record is a secret. It lives only in the
 * district's own Durable Object storage, and only public halves leave it (the tool JWKS).
 */
export const StoredToolKeySet = z.strictObject({
  signing: StoredToolKey,
  retired: z.array(StoredToolKey).max(10),
  /** When `signing` started signing. */
  since: UtcTimestamp,
});
/** A stored tool key set. */
export type StoredToolKeySet = z.infer<typeof StoredToolKeySet>;

/** What a rotation did, for the operator who asked for it. Key IDs only, never key material. */
export interface ToolKeyRotation {
  /** The key that signs from now on. */
  readonly signingKid: string;
  /** The keys still published, newest first. */
  readonly retiredKids: readonly string[];
  readonly since: string;
}

/**
 * The tool's signing keys, kept in the district's record table so they survive restarts and
 * deploys, with rotation. The first read generates a key if none is stored. Generating is
 * asynchronous, so it happens before the atomic step that stores it, and if two first reads race,
 * the key stored first wins and the other is discarded: every isolate signs with the same key.
 *
 * The broker reads keys synchronously (`LtiBrokerOptions.toolKeys`), so a host awaits
 * {@link keySet} once per request and hands the broker the result.
 */
export class TableToolKeyStore {
  readonly #table: RecordTable;
  readonly #now: Clock;
  #imported: { fingerprint: string; set: Promise<ToolKeySet> } | undefined;

  constructor(table: RecordTable, now: Clock = Date.now) {
    this.#table = table;
    this.#now = now;
  }

  /** The current key set, generating and storing the first key if there is none. */
  async keySet(): Promise<ToolKeySet> {
    const stored = this.#read() ?? (await this.#initialize());
    return this.#import(stored);
  }

  /**
   * Switches signing to a freshly generated key. The previous signing key is retired and stays
   * published, with at most `keepRetired` retired keys in all, newest first. Takes effect for every
   * later request as soon as it returns.
   */
  async rotate(keepRetired: number = DEFAULT_RETIRED_KEYS): Promise<ToolKeyRotation> {
    const next = await generateToolKey();
    const since = new Date(this.#now()).toISOString();
    const rotated = this.#table.atomically(() => {
      const current = this.#read();
      const record: StoredToolKeySet = current === undefined
        ? { signing: next, retired: [], since }
        : { signing: next, retired: [current.signing, ...current.retired].slice(0, Math.max(0, keepRetired)), since };
      this.#table.put(TOOL_KEYS_COLLECTION, TOOL_KEYS_RECORD, StoredToolKeySet.parse(record));
      return record;
    });
    return { signingKid: rotated.signing.kid, retiredKids: rotated.retired.map((key) => key.kid), since: rotated.since };
  }

  async #initialize(): Promise<StoredToolKeySet> {
    const first: StoredToolKeySet = { signing: await generateToolKey(), retired: [], since: new Date(this.#now()).toISOString() };
    return this.#table.atomically(() => {
      const raced = this.#read();
      if (raced !== undefined) return raced;
      this.#table.put(TOOL_KEYS_COLLECTION, TOOL_KEYS_RECORD, first);
      return first;
    });
  }

  #read(): StoredToolKeySet | undefined {
    const row = this.#table.get(TOOL_KEYS_COLLECTION, TOOL_KEYS_RECORD);
    if (row === undefined) return undefined;
    const parsed = StoredToolKeySet.safeParse(row.value);
    if (!parsed.success) throw new LtiStoredRecordError(`a ${TOOL_KEYS_COLLECTION} record does not match its schema`);
    return parsed.data;
  }

  // Importing is WebCrypto work, so the imported set is kept until the stored key IDs change.
  #import(stored: StoredToolKeySet): Promise<ToolKeySet> {
    const fingerprint = [stored.signing, ...stored.retired].map((key) => key.kid).join(" ");
    if (this.#imported?.fingerprint !== fingerprint) {
      const set = Promise.all([importToolKey(stored.signing), ...stored.retired.map(importToolKey)])
        .then(([signing, ...retired]) => createToolKeySet(signing!, retired));
      // A failed import is not kept, so the next read tries again.
      set.catch(() => {
        if (this.#imported?.set === set) this.#imported = undefined;
      });
      this.#imported = { fingerprint, set };
    }
    return this.#imported.set;
  }
}
