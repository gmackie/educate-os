import { z } from "zod";
import { EducateOsError } from "@educateos/contracts";
import type { Clock } from "./stores.ts";

/**
 * One key in a platform JWKS. A stripping `z.object`, not `z.strictObject`: a JWKS legitimately
 * carries members the broker ignores (`x5c`, `x5t`, `key_ops`), and rejecting them would refuse a
 * platform's whole key set.
 */
const PlatformJwk = z.object({
  kty: z.literal("RSA"),
  kid: z.string().min(1).max(256),
  n: z.string().min(1),
  e: z.string().min(1),
  alg: z.literal("RS256").optional(),
  use: z.literal("sig").optional(),
});

const PlatformJwks = z.object({ keys: z.array(z.unknown()) });

/** RSA keys shorter than this are refused even when the platform publishes them. */
const MIN_MODULUS_BITS = 2048;

/** How the cache fetches and how long it trusts what it fetched. */
export interface PlatformJwksCacheOptions {
  /** The fetch to use. Injected so tests and Workers can supply their own. */
  readonly fetch: typeof fetch;
  readonly now?: Clock;
  /**
   * How long a fetched key set is trusted, in milliseconds. A key the platform has withdrawn (after
   * a compromise, say) stops verifying at most this long after it disappears. Default 10 minutes.
   */
  readonly maxAgeMs?: number;
  /**
   * The minimum time between refetches triggered by an unknown `kid`, in milliseconds, so a stream
   * of tokens with made-up key IDs cannot make the broker hammer the platform. Default 30 seconds.
   */
  readonly minRefetchIntervalMs?: number;
}

interface CachedKeySet {
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly fetchedAt: number;
}

/**
 * Caches the verification keys of every platform JWKS the broker has fetched, keyed by URL.
 *
 * Rotation: a token signed with a `kid` the cached set lacks triggers one refetch (rate limited by
 * `minRefetchIntervalMs`), so a platform's new key verifies as soon as the platform publishes it.
 * A set older than `maxAgeMs` is refetched before use, so a withdrawn key stops verifying.
 */
export class PlatformJwksCache {
  readonly #fetch: typeof fetch;
  readonly #now: Clock;
  readonly #maxAgeMs: number;
  readonly #minRefetchIntervalMs: number;
  readonly #sets = new Map<string, CachedKeySet>();
  readonly #inFlight = new Map<string, Promise<CachedKeySet>>();

  constructor(options: PlatformJwksCacheOptions) {
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
    this.#maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
    this.#minRefetchIntervalMs = options.minRefetchIntervalMs ?? 30_000;
  }

  /**
   * The RS256 verification key `kid` in the JWKS at `jwksUrl`. Throws
   * `EducateOsError("unauthenticated")` if the platform does not publish it, and
   * `EducateOsError("unavailable")` if the JWKS cannot be fetched or parsed.
   */
  async getKey(jwksUrl: string, kid: string): Promise<CryptoKey> {
    const cached = this.#sets.get(jwksUrl);
    const age = cached === undefined ? Infinity : this.#now() - cached.fetchedAt;
    const mayRefetchForKid = cached !== undefined && !cached.keys.has(kid) && age >= this.#minRefetchIntervalMs;
    const set = cached === undefined || age >= this.#maxAgeMs || mayRefetchForKid ? await this.#refetch(jwksUrl) : cached;
    const key = set.keys.get(kid);
    if (key === undefined) throw new EducateOsError("unauthenticated", "The launch was signed with an unknown key.");
    return key;
  }

  #refetch(jwksUrl: string): Promise<CachedKeySet> {
    // Concurrent launches share one fetch.
    let pending = this.#inFlight.get(jwksUrl);
    if (pending === undefined) {
      pending = this.#load(jwksUrl).finally(() => this.#inFlight.delete(jwksUrl));
      this.#inFlight.set(jwksUrl, pending);
    }
    return pending;
  }

  async #load(jwksUrl: string): Promise<CachedKeySet> {
    let body: unknown;
    try {
      const response = await this.#fetch(jwksUrl, { headers: { accept: "application/json" }, redirect: "error" });
      if (!response.ok) throw new Error(`status ${response.status}`);
      body = await response.json();
    } catch {
      throw new EducateOsError("unavailable", "The LTI platform's key set could not be fetched.");
    }
    const parsed = PlatformJwks.safeParse(body);
    if (!parsed.success) throw new EducateOsError("unavailable", "The LTI platform's key set is malformed.");

    const keys = new Map<string, CryptoKey>();
    for (const candidate of parsed.data.keys) {
      // Keys of other types or uses are skipped rather than failing the set: a platform may publish
      // an encryption key or an EC key beside its RS256 signing keys.
      const jwk = PlatformJwk.safeParse(candidate);
      if (!jwk.success || keys.has(jwk.data.kid)) continue;
      const key = await importRs256Key(jwk.data);
      if (key !== undefined) keys.set(jwk.data.kid, key);
    }
    const set = { keys, fetchedAt: this.#now() };
    this.#sets.set(jwksUrl, set);
    return set;
  }
}

async function importRs256Key(jwk: z.infer<typeof PlatformJwk>): Promise<CryptoKey | undefined> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const { modulusLength } = key.algorithm as { modulusLength?: number };
    return (modulusLength ?? 0) >= MIN_MODULUS_BITS ? key : undefined;
  } catch {
    return undefined;
  }
}
