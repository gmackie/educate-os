// The single-use store is extracted from PlayTrek `packages/lti/src/linking/launch-tokens.ts` at
// commit 7258e4347: random 32-byte base64url tokens with an expiry, usable once. It now uses Web
// Crypto instead of `node:crypto`, and `take` checks and consumes in one step; PlayTrek checked
// `usedAt` and marked it in separate statements, so two concurrent requests could both pass.
import { EducateOsError } from "@educateos/contracts";
import {
  ActivityLink,
  PlatformRegistration,
  type PlatformRegistrationStore,
  type RegistrationKey,
} from "./registration.ts";

/** Milliseconds since the epoch. Injected so tests control time. */
export type Clock = () => number;

/**
 * A store of values that can each be read exactly once before they expire. Login state, nonces and
 * deep linking sessions live here, which is what makes a replayed launch fail.
 *
 * `take` must be atomic: of two concurrent calls for one key, at most one may receive the value. A
 * Durable Object or a database row deleted with `DELETE … RETURNING` satisfies that; an eventually
 * consistent KV namespace does not.
 */
export interface SingleUseStore<T> {
  /** Stores `value` under `key` until `expiresAt` (milliseconds since the epoch). */
  put(key: string, value: T, expiresAt: number): Promise<void>;
  /** Removes and returns the value under `key`, or `undefined` if it is absent, used or expired. */
  take(key: string): Promise<T | undefined>;
}

/** An in-memory {@link SingleUseStore}, for tests and single-isolate development. */
export class InMemorySingleUseStore<T> implements SingleUseStore<T> {
  readonly #entries = new Map<string, { value: T; expiresAt: number }>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async put(key: string, value: T, expiresAt: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt });
  }

  async take(key: string): Promise<T | undefined> {
    const entry = this.#entries.get(key);
    this.#entries.delete(key);
    return entry !== undefined && entry.expiresAt > this.#now() ? entry.value : undefined;
  }
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/** A random, URL-safe token with 256 bits of entropy. */
export function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The SHA-256 of `value`'s UTF-8 bytes, base64url-encoded. */
export async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

const keyOf = (key: RegistrationKey): string => JSON.stringify([key.issuer, key.clientId]);

/** An in-memory {@link PlatformRegistrationStore}. */
export class InMemoryPlatformRegistrationStore implements PlatformRegistrationStore {
  readonly #registrations = new Map<string, PlatformRegistration>();

  /**
   * Validates every registration. Throws if one is malformed or two share an
   * `(issuer, clientId)`.
   */
  constructor(registrations: readonly PlatformRegistration[]) {
    for (const input of registrations) {
      const registration = PlatformRegistration.parse(input);
      const key = keyOf(registration);
      if (this.#registrations.has(key)) {
        throw new EducateOsError("conflict", "Two LTI registrations share an issuer and client ID.");
      }
      this.#registrations.set(key, registration);
    }
  }

  async get(key: RegistrationKey): Promise<PlatformRegistration | undefined> {
    return this.#registrations.get(keyOf(key));
  }

  async listByIssuer(issuer: string): Promise<readonly PlatformRegistration[]> {
    return [...this.#registrations.values()].filter((registration) => registration.issuer === issuer);
  }

  async addActivityLink(key: RegistrationKey, link: ActivityLink): Promise<void> {
    const registration = this.#registrations.get(keyOf(key));
    if (registration === undefined) throw new EducateOsError("not-found", "No such LTI registration.");
    // The link is parsed on its own first, so the only way the whole registration can then fail is
    // the refinement that rejects a duplicate (offering, link) pair.
    const updated = PlatformRegistration.safeParse({
      ...registration,
      activityLinks: [...registration.activityLinks, ActivityLink.parse(link)],
    });
    if (!updated.success) throw new EducateOsError("conflict", "That link is already mapped in this offering.");
    this.#registrations.set(keyOf(key), updated.data);
  }
}
