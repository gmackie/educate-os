import {
  PlatformServiceTokenRecord,
  type Clock,
  type PlatformServiceTokenStore,
  type PlatformToolId,
} from "@educateos/lti";
import { LtiStoredRecordError } from "./stores.ts";
import { tupleKey, type RecordTable } from "./table.ts";

/** The collections the LTI Platform's token endpoint keeps its state in (SCHO-179). */
export const PLATFORM_TOKEN_COLLECTIONS = {
  /** The client assertion `jti`s already used, per tool, each until its assertion expires. */
  assertions: "lti.platform-assertion",
  /** The access tokens issued, keyed by the token's digest, each until it expires. */
  accessTokens: "lti.platform-access-token",
} as const;

/**
 * The token endpoint's used assertions and issued access tokens, over the district's record table.
 * A `jti` is checked and recorded in one atomic step, so of any number of concurrent requests with
 * one assertion exactly one is accepted, and the record outlives a restart of the object. Expired
 * rows are purged as new ones are written.
 */
export class TablePlatformServiceTokenStore implements PlatformServiceTokenStore {
  readonly #table: RecordTable;
  readonly #now: Clock;

  constructor(table: RecordTable, now: Clock = Date.now) {
    this.#table = table;
    this.#now = now;
  }

  async claimAssertion(toolId: PlatformToolId, jti: string, expiresAt: number): Promise<boolean> {
    const { assertions } = PLATFORM_TOKEN_COLLECTIONS;
    const key = tupleKey(toolId, jti);
    return this.#table.atomically(() => {
      // Purged first, so a record still here has not expired.
      this.#table.purgeExpired(assertions, this.#now());
      if (this.#table.get(assertions, key) !== undefined) return false;
      this.#table.put(assertions, key, {}, expiresAt);
      return true;
    });
  }

  async putToken(digest: string, record: PlatformServiceTokenRecord, expiresAt: number): Promise<void> {
    const parsed = PlatformServiceTokenRecord.parse(record);
    this.#table.atomically(() => {
      this.#table.purgeExpired(PLATFORM_TOKEN_COLLECTIONS.accessTokens, this.#now());
      this.#table.put(PLATFORM_TOKEN_COLLECTIONS.accessTokens, digest, parsed, expiresAt);
    });
  }

  async getToken(digest: string): Promise<{ record: PlatformServiceTokenRecord; expiresAt: number } | undefined> {
    const row = this.#table.get(PLATFORM_TOKEN_COLLECTIONS.accessTokens, digest);
    if (row === undefined || row.expiresAt === undefined || row.expiresAt <= this.#now()) return undefined;
    const record = PlatformServiceTokenRecord.safeParse(row.value);
    if (!record.success) throw new LtiStoredRecordError(`a ${PLATFORM_TOKEN_COLLECTIONS.accessTokens} record does not match its schema`);
    return { record: record.data, expiresAt: row.expiresAt };
  }
}
