/**
 * The device credential client (SCHO-261 protocol, docs: "EducateOS Mobile: Device credentials").
 *
 * - The phone holds a P-256 key that never leaves it. Every `/api/m/*` request carries
 *   `Authorization: Device <accessToken>` and a fresh `Device-Proof`: a compact ES256 JWS over
 *   `{htm, htu, iat, ath, jti}` with a raw 64-byte r||s signature.
 * - Access tokens last 15 minutes. A `token-expired` refusal refreshes once (single-flight: a second
 *   concurrent refresh would present a used refresh token, and the district revokes the device for
 *   that) and retries with a new proof.
 * - `device-revoked` / `refresh-token-reused` forget the tokens and key and report the phone as
 *   signed out by the school. Redirects (an Access login page) become `needs-sign-in`.
 *
 * This module is platform-neutral: storage, randomness, time and fetch are injected, so the same
 * code runs under Node's test runner and in the app (see deviceVault.ts for SecureStore).
 */
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad } from '@scure/base';
import { DistrictApiError, MESSAGES, errorFrom, isRedirect } from './errors.ts';

export const DEVICE_API_PREFIX = '/api/m/';
export const REFRESH_PATH = '/api/m/token/refresh';
/** Refresh this long before the access token's stated expiry. */
const EARLY_REFRESH_MS = 30_000;
const encoder = new TextEncoder();
const ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

export type PublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

/** Everything a paired phone keeps, in one SecureStore entry so both tokens are replaced at once. */
export type StoredDevice = {
  v: 1;
  deviceId: string;
  principalId: string;
  /** The raw 32-byte P-256 scalar, base64url. */
  privateKey: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
};

export interface DeviceVault {
  load(): Promise<StoredDevice | null>;
  save(device: StoredDevice): Promise<void>;
  clear(): Promise<void>;
}

export type DeviceTokens = {
  deviceId: string; accessToken: string; refreshToken: string;
  accessTokenExpiresAt?: string; refreshTokenExpiresAt?: string;
};

export const REVOKED_REASONS = new Set(['device-revoked', 'refresh-token-reused']);
/** Refusals answered by one refresh and retry. Unknown reasons are treated the same way. */
export const RETRY_AFTER_REFRESH = new Set(['token-expired', 'missing-credentials', 'invalid-token', 'invalid-proof', 'proof-replayed']);
const PAIR_AGAIN = new Set(['invalid-refresh-token', 'refresh-token-expired']);

export function b64url(bytes: Uint8Array): string { return base64urlnopad.encode(bytes); }

/** A new device key from 32 random bytes per try (rejection sampling keeps the scalar in range). */
export function generateDeviceKey(randomBytes: (n: number) => Uint8Array): { privateKey: Uint8Array; publicJwk: PublicJwk } {
  for (let i = 0; i < 16; i++) {
    const candidate = randomBytes(32);
    const scalar = BigInt('0x' + Array.from(candidate, (b) => b.toString(16).padStart(2, '0')).join(''));
    if (scalar > 0n && scalar < ORDER) return { privateKey: candidate, publicJwk: publicJwkOf(candidate) };
  }
  throw new Error('Could not create a device key.');
}

export function publicJwkOf(privateKey: Uint8Array): PublicJwk {
  const point = p256.getPublicKey(privateKey, false);
  return { kty: 'EC', crv: 'P-256', x: b64url(point.slice(1, 33)), y: b64url(point.slice(33, 65)) };
}

/** base64url(SHA-256(ASCII token)), the proof's `ath`. */
export function tokenHash(token: string): string { return b64url(sha256(encoder.encode(token))); }

/** The `Device-Proof` header: a compact ES256 JWS signed with the device key. */
export function createProof(privateKey: Uint8Array, claims: { htm: string; htu: string; token: string; iat: number; jti: string }): string {
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'ES256', typ: 'device-proof+jwt' })));
  const payload = b64url(encoder.encode(JSON.stringify({
    htm: claims.htm, htu: claims.htu, iat: claims.iat, ath: tokenHash(claims.token), jti: claims.jti,
  })));
  const input = header + '.' + payload;
  // noble hashes with SHA-256 and returns the 64-byte compact (IEEE P1363) form WebCrypto verifies.
  const signature = p256.sign(encoder.encode(input), privateKey);
  return input + '.' + b64url(signature);
}

/** Parses a registration or refresh response. Expiries default to the protocol's lifetimes. */
export function readTokens(value: unknown, now: number): Omit<StoredDevice, 'v' | 'principalId' | 'privateKey'> {
  const t = value && typeof value === 'object' ? value as Partial<Record<keyof DeviceTokens, unknown>> : {};
  if (typeof t.deviceId !== 'string' || !/^dev_[A-Za-z0-9_-]{16,64}$/.test(t.deviceId) ||
      typeof t.accessToken !== 'string' || t.accessToken.length < 8 || t.accessToken.length > 4096 ||
      typeof t.refreshToken !== 'string' || t.refreshToken.length < 8 || t.refreshToken.length > 4096) {
    throw new DistrictApiError(502, 'unavailable', MESSAGES.unavailable);
  }
  const time = (v: unknown, fallback: number) => {
    const parsed = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    deviceId: t.deviceId, accessToken: t.accessToken, refreshToken: t.refreshToken,
    accessTokenExpiresAt: time(t.accessTokenExpiresAt, now + 14 * 60_000),
    refreshTokenExpiresAt: time(t.refreshTokenExpiresAt, now + 29 * 86_400_000),
  };
}

/** The `reason` of a device-auth 401, from the body or the WWW-Authenticate header. */
export async function refusalReason(response: Response): Promise<string> {
  const header = /error="([a-z-]{1,40})"/.exec(response.headers.get('www-authenticate') || '')?.[1];
  const body: unknown = await response.clone().json().catch(() => null);
  const reason = body && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' ? reason : header || 'missing-credentials';
}

export type DeviceSessionOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  randomId: () => string;
  /** Called once when the school revokes this phone; the vault is already cleared. */
  onRevoked?: () => void;
};

type Query = Record<string, string>;

/** One district's device credential: proofs, single-flight refresh and revocation. */
export class DeviceSession {
  private cached: StoredDevice | null | undefined;
  private refreshing: Promise<StoredDevice> | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(readonly origin: string, private readonly vault: DeviceVault, private readonly options: DeviceSessionOptions) {
    this.fetch = options.fetch ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  async device(): Promise<StoredDevice | null> {
    if (this.cached === undefined) this.cached = await this.vault.load();
    return this.cached;
  }

  /** A JSON call to `/api/<rest>`, sent as `/api/m/<rest>`. */
  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Query): Promise<T> {
    if (!path.startsWith('/api/') || path.startsWith('/api/m/')) throw new Error('Invalid district API path.');
    const devicePath = DEVICE_API_PREFIX + path.slice('/api/'.length);
    let current = await this.device();
    if (!current) throw new DistrictApiError(401, 'needs-pairing', MESSAGES.needsPairing);
    if (current.accessTokenExpiresAt - EARLY_REFRESH_MS <= this.now()) current = await this.refresh(current.accessToken);
    let response = await this.send(current, method, devicePath, body, query);
    if (response.status === 401) {
      const reason = await refusalReason(response);
      if (REVOKED_REASONS.has(reason)) return this.revoked();
      // token-expired, or a client/clock problem (RETRY_AFTER_REFRESH): refresh once, then retry.
      current = await this.refresh(current.accessToken);
      response = await this.send(current, method, devicePath, body, query);
      if (response.status === 401) {
        const again = await refusalReason(response);
        if (REVOKED_REASONS.has(again)) return this.revoked();
        throw await this.pairAgain();
      }
    }
    return this.read<T>(response);
  }

  /**
   * Refreshes at most once at a time. A caller whose request failed with `stale` gets the tokens
   * someone else already refreshed rather than spending the (now used) refresh token again.
   */
  refresh(stale: string): Promise<StoredDevice> {
    if (!this.refreshing) {
      this.refreshing = this.refreshOnce(stale).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  /** Forgets this phone's credential locally. */
  async forget(): Promise<void> {
    this.cached = null;
    await this.vault.clear();
  }

  private async refreshOnce(stale: string): Promise<StoredDevice> {
    const current = await this.device();
    if (!current) throw new DistrictApiError(401, 'needs-pairing', MESSAGES.needsPairing);
    if (current.accessToken !== stale) return current;
    if (current.refreshTokenExpiresAt <= this.now()) throw await this.pairAgain();
    let response: Response;
    try {
      response = await this.fetch(this.origin + REFRESH_PATH, {
        method: 'POST', redirect: 'manual',
        headers: {
          accept: 'application/json', 'content-type': 'application/json',
          'device-proof': this.proof(current, 'POST', REFRESH_PATH, current.refreshToken),
        },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
    } catch { throw new DistrictApiError(0, 'unreachable', MESSAGES.unreachable); }
    if (isRedirect(response)) throw new DistrictApiError(401, 'needs-sign-in', MESSAGES.needsSignIn);
    if (response.status === 401) {
      const reason = await refusalReason(response);
      if (REVOKED_REASONS.has(reason)) return this.revoked();
      if (PAIR_AGAIN.has(reason)) throw await this.pairAgain();
      // A proof or clock problem: keep the credential so a later attempt can still succeed.
      throw new DistrictApiError(401, 'needs-sign-in', MESSAGES.needsSignIn);
    }
    if (response.status === 503) throw new DistrictApiError(503, 'unavailable', MESSAGES.deviceAuthUnavailable);
    if (!response.ok) throw new DistrictApiError(response.status, 'unavailable', MESSAGES.unavailable);
    const tokens = readTokens(await response.json().catch(() => null), this.now());
    if (tokens.deviceId !== current.deviceId) throw new DistrictApiError(502, 'unavailable', MESSAGES.unavailable);
    const next: StoredDevice = { ...current, ...tokens };
    await this.vault.save(next);
    this.cached = next;
    return next;
  }

  private proof(device: StoredDevice, htm: string, htu: string, token: string): string {
    return createProof(base64urlnopad.decode(device.privateKey), {
      htm, htu, token, iat: Math.floor(this.now() / 1000), jti: this.options.randomId(),
    });
  }

  private async send(device: StoredDevice, method: string, path: string, body: unknown, query?: Query): Promise<Response> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith(DEVICE_API_PREFIX)) throw new Error('Invalid district API path.');
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    try {
      return await this.fetch(url.toString(), {
        method, redirect: 'manual',
        headers: {
          accept: 'application/json',
          authorization: 'Device ' + device.accessToken,
          // A new proof for every request, retries included: the district rejects a reused jti.
          'device-proof': this.proof(device, method, url.pathname, device.accessToken),
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch { throw new DistrictApiError(0, 'unreachable', MESSAGES.unreachable); }
  }

  private async read<T>(response: Response): Promise<T> {
    if (isRedirect(response)) throw new DistrictApiError(401, 'needs-sign-in', MESSAGES.needsSignIn);
    if (response.status === 503) {
      const body: unknown = await response.clone().json().catch(() => null);
      if ((body as { reason?: unknown } | null)?.reason === 'device-auth-unavailable') {
        throw new DistrictApiError(503, 'unavailable', MESSAGES.deviceAuthUnavailable);
      }
    }
    if (!response.ok) throw await errorFrom(response);
    return await response.json().catch(() => null) as T;
  }

  private async revoked(): Promise<never> {
    await this.forget();
    this.options.onRevoked?.();
    throw new DistrictApiError(401, 'device-revoked', MESSAGES.revoked);
  }

  private async pairAgain(): Promise<DistrictApiError> {
    await this.forget();
    return new DistrictApiError(401, 'needs-pairing', MESSAGES.needsPairing);
  }
}
