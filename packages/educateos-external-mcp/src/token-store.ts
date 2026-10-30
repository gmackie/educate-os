import type { AccessGrant, TokenStore } from "./auth.ts";

/** Minimal Durable Object transactional storage surface; no Workers runtime dependency. */
export interface GrantTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Durable Object storage, with atomic transactions over grant entries. */
export interface GrantStorage extends GrantTransaction {
  transaction<T>(callback: (storage: GrantTransaction) => Promise<T>): Promise<T>;
}

/**
 * Shared durable replay and revocation storage. Bind one district's authority to one Durable
 * Object, so atomic assertion claims hold across requests and isolates. Expired entries can be
 * purged by the host after their recorded expiry; retaining a replay tombstone is safe.
 */
export class DurableTokenStore implements TokenStore {
  readonly #storage: GrantStorage;
  constructor(storage: GrantStorage) {
    this.#storage = storage;
  }

  async claimAssertion(key: string, expiresAt: number): Promise<boolean> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const name = `mcp:assertion:${Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("")}`;
    return this.#storage.transaction(async (storage) => {
      if ((await storage.get(name)) !== undefined) return false;
      await storage.put(name, expiresAt);
      return true;
    });
  }

  putAccess(digest: string, grant: AccessGrant): Promise<void> {
    return this.#storage.put(`mcp:access:${digest}`, grant);
  }

  getAccess(digest: string): Promise<AccessGrant | undefined> {
    return this.#storage.get(`mcp:access:${digest}`);
  }

  /** Local revocation takes effect on the next request. The input is the stored bearer digest. */
  async revokeAccess(digest: string): Promise<void> {
    await this.#storage.delete(`mcp:access:${digest}`);
  }
}
