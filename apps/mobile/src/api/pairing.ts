/**
 * QR phone pairing against the district's own relay (`/api/pair/*`, one-origin design, SCHO-262).
 *
 * The contract this client implements (the relay is built in parallel; keep the two in step):
 *
 * 1. A signed-in browser creates a room: `POST <origin>/api/pair/rooms`. The page shows the QR
 *    `https://mobile.educateos.io/j#o=<origin>&r=<room>&s=<secret>` (parsed by security.ts
 *    `parseJoinLink`). The room lasts about two minutes and holds one phone.
 * 2. The phone claims it with the public half of its new device key:
 *      POST <origin>/api/pair/rooms/:room/claim
 *      {"secret": "<s>", "publicJwk": {"kty":"EC","crv":"P-256","x":"…","y":"…"},
 *       "device": {"label": "Ava's iPhone", "platform": "ios", "model": "iPhone 16", "appVersion": "0.1.0"}}
 *    → 200 {"code": "K7Q4M2XD"}
 *    Both screens show the same 8-character code; the person compares them and approves in the browser.
 * 3. The phone polls:
 *      GET <origin>/api/pair/rooms/:room?secret=<s>
 *    → 200 {"state": "waiting" | "approved" | "denied" | "expired", "sealed"?: {"epk": JWK, "iv": b64url, "ct": b64url}}
 * 4. On approval the district has registered the device (SCHO-261 `registerDevice`) and sealed
 *    `{"deviceId", "accessToken", "refreshToken", "principalId"}` (optionally with
 *    `accessTokenExpiresAt` / `refreshTokenExpiresAt`) to the phone's key:
 *      shared = ECDH-P256(epk, device key)  — the X coordinate, as WebCrypto deriveBits returns
 *      key    = HKDF-SHA-256(ikm = shared, salt = UTF-8 bytes of the room id, info = "educateos-pair-v2", 32 bytes)
 *      ct     = AES-256-GCM(key, iv (12 bytes), plaintext JSON), no additional data; ct includes the tag
 *
 * Every call uses `redirect: 'manual'`; a 3xx means the relay is still behind Access, which we
 * report as pairing being unavailable. Errors are always written for people.
 */
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { base64urlnopad } from '@scure/base';
import type { PublicJwk } from './device.ts';

export const PAIR_HKDF_INFO = 'educateos-pair-v2';
export const PAIRING_TIMEOUT_MS = 125_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type JoinLink = { origin: string; room: string; secret: string };
export type PairDevice = { label: string; platform: 'ios' | 'android' | 'web' | 'other'; model: string; appVersion: string };
export type Sealed = { epk: { kty: string; crv: string; x: string; y: string }; iv: string; ct: string };
export type PairState = { state: 'waiting' | 'approved' | 'denied' | 'expired'; sealed?: Sealed };
export type PairCredential = {
  deviceId: string; accessToken: string; refreshToken: string; principalId: string;
  accessTokenExpiresAt?: string; refreshTokenExpiresAt?: string;
};

export class PairingError extends Error {
  constructor(public readonly code: 'expired' | 'denied' | 'used' | 'unavailable' | 'unreachable' | 'invalid' | 'cancelled', message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

const MESSAGE = {
  expired: 'This code has expired. On the computer, choose Connect phone again for a new code.',
  denied: 'The connection was declined on the computer.',
  used: 'Another phone already used this code. Make a new one on the computer.',
  unavailable: "Your school hasn't turned on phone pairing yet.",
  unreachable: "We couldn't reach your school. Check your internet connection and try again.",
  invalid: 'The school sent a response this app could not verify. Make a new code and try again.',
  cancelled: 'Pairing cancelled.',
} as const;

const fail = (code: keyof typeof MESSAGE) => new PairingError(code, MESSAGE[code]);

/** Limits the device description to what the district accepts. */
export function clampDevice(device: PairDevice): PairDevice {
  return {
    label: device.label.trim().slice(0, 80) || 'Phone', platform: device.platform,
    model: device.model.trim().slice(0, 80) || 'Unknown', appVersion: device.appVersion.trim().slice(0, 40) || '0',
  };
}

/** "K7Q4M2XD" → "K7Q4·M2XD". */
export function formatCode(code: string): string { return code.slice(0, 4) + '·' + code.slice(4); }

type Fetch = typeof fetch;

async function call(fetchImpl: Fetch, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'manual', headers: { accept: 'application/json', ...init.headers } });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw fail('cancelled');
    throw fail('unreachable');
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw fail('unavailable');
  if (response.status === 404 || response.status === 410) throw fail('expired');
  if (response.status === 409) throw fail('used');
  if (response.status === 403) throw fail('denied');
  if (!response.ok) throw fail(response.status === 503 || response.status === 501 ? 'unavailable' : 'invalid');
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== 'object') throw fail('invalid');
  return value;
}

function roomUrl(link: JoinLink, suffix = ''): string {
  return link.origin + '/api/pair/rooms/' + encodeURIComponent(link.room) + suffix;
}

export async function claimRoom(fetchImpl: Fetch, link: JoinLink, publicJwk: PublicJwk, device: PairDevice, signal?: AbortSignal): Promise<string> {
  const value = await call(fetchImpl, roomUrl(link, '/claim'), {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: link.secret, publicJwk, device: clampDevice(device) }),
  }) as { code?: unknown };
  const code = typeof value.code === 'string' ? value.code.toUpperCase() : '';
  if (!/^[0-9A-Z]{8}$/.test(code)) throw fail('invalid');
  return code;
}

export async function pollRoom(fetchImpl: Fetch, link: JoinLink, signal?: AbortSignal): Promise<PairState> {
  const value = await call(fetchImpl, roomUrl(link, '?secret=' + encodeURIComponent(link.secret)), { method: 'GET', signal }) as Partial<PairState>;
  if (value.state !== 'waiting' && value.state !== 'approved' && value.state !== 'denied' && value.state !== 'expired') throw fail('invalid');
  return value.state === 'approved' ? { state: 'approved', sealed: value.sealed } : { state: value.state };
}

function bytes(value: unknown, length?: number): Uint8Array {
  if (typeof value !== 'string') throw new Error('missing');
  const decoded = base64urlnopad.decode(value);
  if (length !== undefined && decoded.length !== length) throw new Error('length');
  return decoded;
}

/** Opens the sealed credential with the device key. Any failure is one generic error. */
export function unsealPairing(sealed: Sealed | undefined, privateKey: Uint8Array, room: string): PairCredential {
  let key: Uint8Array | undefined;
  let shared: Uint8Array | undefined;
  try {
    if (!sealed || sealed.epk?.kty !== 'EC' || sealed.epk.crv !== 'P-256') throw new Error('epk');
    const point = new Uint8Array(65);
    point[0] = 4; point.set(bytes(sealed.epk.x, 32), 1); point.set(bytes(sealed.epk.y, 32), 33);
    shared = p256.getSharedSecret(privateKey, point);
    key = hkdf(sha256, shared.slice(1, 33), encoder.encode(room), encoder.encode(PAIR_HKDF_INFO), 32);
    const ct = bytes(sealed.ct);
    if (ct.length < 17 || ct.length > 16_384) throw new Error('ct');
    const plaintext = gcm(key, bytes(sealed.iv, 12)).decrypt(ct);
    const value = JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
    const text = (k: string, max = 4096) => {
      const v = value[k];
      if (typeof v !== 'string' || v.length < 1 || v.length > max) throw new Error(k);
      return v;
    };
    const optional = (k: string) => typeof value[k] === 'string' ? value[k] as string : undefined;
    const credential: PairCredential = {
      deviceId: text('deviceId', 80), accessToken: text('accessToken'), refreshToken: text('refreshToken'),
      principalId: text('principalId', 200),
    };
    const at = optional('accessTokenExpiresAt'), rt = optional('refreshTokenExpiresAt');
    if (at) credential.accessTokenExpiresAt = at;
    if (rt) credential.refreshTokenExpiresAt = rt;
    if (!/^dev_[A-Za-z0-9_-]{16,64}$/.test(credential.deviceId)) throw new Error('deviceId');
    return credential;
  } catch {
    throw fail('invalid');
  } finally {
    key?.fill(0);
    shared?.fill(0);
  }
}

export type PairOptions = {
  link: JoinLink;
  privateKey: Uint8Array;
  publicJwk: PublicJwk;
  device: PairDevice;
  onCode: (code: string) => void;
  signal: AbortSignal;
  fetch?: Fetch;
  now?: () => number;
  intervalMs?: number;
};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(fail('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Claim, show the code, wait for approval, and open the credential. */
export async function pairPhone(options: PairOptions): Promise<PairCredential> {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const started = now();
  const code = await claimRoom(fetchImpl, options.link, options.publicJwk, options.device, options.signal);
  options.onCode(code);
  while (now() - started < PAIRING_TIMEOUT_MS) {
    await wait(options.intervalMs ?? 1500, options.signal);
    const room = await pollRoom(fetchImpl, options.link, options.signal);
    if (room.state === 'approved') return unsealPairing(room.sealed, options.privateKey, options.link.room);
    if (room.state === 'denied') throw fail('denied');
    if (room.state === 'expired') throw fail('expired');
  }
  throw fail('expired');
}
