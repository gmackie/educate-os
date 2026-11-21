import { z } from "zod";
import { DelegationId, DistrictId, PrincipalId, UtcTimestamp } from "@educateos/contracts";

/** The ID of a scoped MCP personal bearer token (`mkt_...`). */
export const McpBearerTokenId = z.string().regex(/^mkt_[a-z0-9][a-z0-9-]{0,62}$/, "expected an MCP bearer token ID");
/** A scoped MCP bearer token ID. */
export type McpBearerTokenId = z.infer<typeof McpBearerTokenId>;

/** Prefix carried by every scoped MCP bearer token secret so authenticators recognize it without DB guesswork. */
export const MCP_BEARER_TOKEN_PREFIX = "edum_";

/**
 * A scoped personal bearer token stored in the district. The secret itself is never persisted:
 * only its SHA-256 hex digest is stored, and every call is bounded by the referenced IF-06
 * {@link DelegationId} and the principal's live directory standing.
 */
export const McpBearerTokenRecord = z.strictObject({
  /** Token record ID. */
  id: McpBearerTokenId,
  /** The district this token belongs to. */
  districtId: DistrictId,
  /** The staff principal who minted the token and whom calls act as. */
  principalId: PrincipalId,
  /** The IF-06 delegation that bounds every call made with this token. */
  delegationId: DelegationId,
  /** Human-readable label chosen by the staff member (e.g. "Claude Code on laptop"). */
  label: z.string().trim().min(1).max(120),
  /** Non-secret prefix shown in the UI (`edum_<8 hex>...`). */
  prefix: z.string().min(8).max(24),
  /** SHA-256 hex digest of the full bearer token. Never returned in UI views. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** When the token was created. */
  createdAt: UtcTimestamp,
  /** When the token expires (no later than its delegation's expiry). */
  expiresAt: UtcTimestamp,
  /** When the token was last accepted on `/mcp`. */
  lastUsedAt: UtcTimestamp.optional(),
  /** Present once revoked; rows are kept for auditability. */
  revoked: z.strictObject({ by: PrincipalId, at: UtcTimestamp }).optional(),
});
/** A stored scoped MCP bearer token. */
export type McpBearerTokenRecord = z.infer<typeof McpBearerTokenRecord>;

/** The UI-safe view of a scoped MCP bearer token (omits its SHA-256 digest). */
export const McpBearerTokenView = McpBearerTokenRecord.omit({ digest: true });
/** A UI-safe scoped MCP bearer token. */
export type McpBearerTokenView = z.infer<typeof McpBearerTokenView>;

/** Removes the secret digest from a stored token record before returning it to any UI or API caller. */
export function toMcpBearerTokenView(record: McpBearerTokenRecord): McpBearerTokenView {
  const { digest: _digest, ...view } = record;
  return view;
}

/** Where a district's scoped MCP bearer tokens live. Records are never deleted: revocation marks them. */
export interface McpBearerTokenStore {
  /** One token by ID, or undefined. */
  get(id: McpBearerTokenId): Promise<McpBearerTokenRecord | undefined>;
  /** One token by SHA-256 digest, or undefined. */
  findByDigest(digest: string): Promise<McpBearerTokenRecord | undefined>;
  /** Every token record, oldest first. */
  list(): Promise<McpBearerTokenRecord[]>;
  /** Inserts or replaces a token record. */
  put(record: McpBearerTokenRecord): Promise<void>;
  /**
   * Atomically records `at` as the token's last use, only while it is unrevoked, so a concurrent
   * revocation is never overwritten by a stale read-modify-write.
   */
  touch(id: McpBearerTokenId, at: string): Promise<void>;
}

/** In-memory {@link McpBearerTokenStore} for tests and the local harness. */
export class InMemoryMcpBearerTokenStore implements McpBearerTokenStore {
  readonly #records: McpBearerTokenRecord[] = [];

  async get(id: McpBearerTokenId): Promise<McpBearerTokenRecord | undefined> {
    const found = this.#records.find((r) => r.id === id);
    return found === undefined ? undefined : structuredClone(found);
  }

  async findByDigest(digest: string): Promise<McpBearerTokenRecord | undefined> {
    const found = this.#records.find((r) => r.digest === digest);
    return found === undefined ? undefined : structuredClone(found);
  }

  async list(): Promise<McpBearerTokenRecord[]> {
    return structuredClone(this.#records);
  }

  async put(record: McpBearerTokenRecord): Promise<void> {
    const parsed = McpBearerTokenRecord.parse(record);
    const index = this.#records.findIndex((r) => r.id === parsed.id);
    if (index === -1) this.#records.push(parsed);
    else this.#records[index] = parsed;
  }

  async touch(id: McpBearerTokenId, at: string): Promise<void> {
    const found = this.#records.find((r) => r.id === id);
    if (found !== undefined && found.revoked === undefined) found.lastUsedAt = at;
  }
}

/** Lowercase hex SHA-256 of UTF-8 `value`. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
}

/** Mints a fresh 256-bit `edum_<64 hex>` bearer secret together with its digest and UI prefix. */
export async function mintMcpBearerSecret(): Promise<{ secret: string; digest: string; prefix: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
  const secret = `${MCP_BEARER_TOKEN_PREFIX}${hex}`;
  const digest = await sha256Hex(secret);
  const prefix = `${secret.slice(0, MCP_BEARER_TOKEN_PREFIX.length + 8)}…`;
  return { secret, digest, prefix };
}
