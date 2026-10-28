/**
 * QR phone pairing against the district's own relay (`/api/pair/*`, one-origin design, SCHO-262).
 * The district end is packages/educateos-district-app/src/pairing.ts; docs/educateos/mobile.md
 * ("Pairing v2") is the contract. Keep the two in step.
 *
 * With a computer:
 * 1. A signed-in browser creates a room: `POST <origin>/api/pair/rooms`. The page shows the QR
 *    `https://mobile.educateos.io/j#o=<origin>&r=<room>&s=<secret>` (parsed by security.ts
 *    `parseJoinLink`). The room lasts about two minutes and holds one phone.
 * 2. The phone claims it with the public half of its new device key:
 *      POST <origin>/api/pair/rooms/:room/claim
 *      {"secret": "<s>", "publicJwk": {"kty":"EC","crv":"P-256","x":"…","y":"…"},
 *       "device": {"label": "Ava's iPhone", "platform": "ios", "model": "iPhone 16", "appVersion": "0.1.0"}}
 *    → 200 {"code": "K7Q4M2XD"}
 *    Both screens show the same 8-character code; the person compares them and approves in the browser.
 *    The phone derives the code itself ({@link pairingCode}) and refuses a room that names another.
 *
 * Without a computer (manifest `mobileApi.max >= 2`):
 * 1. The phone opens a room already claimed by its key: `POST <origin>/api/pair/self-rooms`
 *    {"publicJwk", "device"} → 201 {"room", "secret", "code", "expiresAt"}.
 * 2. It opens the system browser at `<origin>/connect-phone?method=<id>&r=<room>&s=<secret>&k=<thumbprint>`,
 *    where the person signs in and approves; the page then returns to `https://mobile.educateos.io/j#…`.
 *
 * Either way the phone then polls (never claims a self-room):
 *      GET <origin>/api/pair/rooms/:room?secret=<s>
 *    → 200 {"state": "waiting" | "approved" | "denied" | "expired", "sealed"?: {"epk": JWK, "iv": b64url, "ct": b64url}}
 *    `sealed` comes once; a later poll answers 410.
 *
 * On approval the district has registered the device (SCHO-261 `registerDevice`) and sealed
 * `{"deviceId", "accessToken", "refreshToken", "principalId"}` with the expiries (named
 * `accessTokenExpiresAt` / `refreshTokenExpiresAt`, or `accessExpiresAt` / `refreshExpiresAt` as the
 * contract first wrote them) to the phone's key:
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
  constructor(public readonly code: 'expired' | 'denied' | 'used' | 'unavailable' | 'busy' | 'unreachable' | 'invalid' | 'cancelled', message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

const MESSAGE = {
  expired: 'This code has expired. On the computer, choose Connect phone again for a new code.',
  denied: 'The connection was declined on the computer.',
  used: 'Another phone already used this code. Make a new one on the computer.',
  unavailable: "Your school hasn't turned on phone pairing yet.",
  busy: 'Too many phones are connecting to your school right now. Try again in a minute.',
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

/** The RFC 7638 thumbprint of the device key, base64url: what `/connect-phone?k=` carries. */
export function jwkThumbprint(jwk: PublicJwk): string {
  return base64urlnopad.encode(sha256(encoder.encode(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))));
}

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * The 8-character code both screens show, derived as the district derives it: SHA-256 over the
 * UTF-8 bytes of the room id followed by the key thumbprint, each of the first eight bytes mod 36
 * into A–Z then 0–9.
 */
export function pairingCode(room: string, thumbprint: string): string {
  return Array.from(sha256(encoder.encode(room + thumbprint)).subarray(0, 8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** A server code must be the one this phone derives for its own key, or another key was bound. */
function checkedCode(value: unknown, room: string, publicJwk: PublicJwk): string {
  const code = typeof value === 'string' ? value.toUpperCase() : '';
  if (!/^[0-9A-Z]{8}$/.test(code) || code !== pairingCode(room, jwkThumbprint(publicJwk))) throw fail('invalid');
  return code;
}

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
  if (response.status === 429) throw fail('busy');
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
  return checkedCode(value.code, link.room, publicJwk);
}

const ROOM_ID = /^[A-Za-z0-9_-]{8,128}$/;
const ROOM_SECRET = /^[A-Za-z0-9_-]{16,256}$/;

/** A room this phone opened for itself, already claimed by its key. */
export type SelfRoom = { link: JoinLink; code: string; thumbprint: string };

/** `POST /api/pair/self-rooms`: the start of "sign in on this phone". */
export async function createSelfRoom(fetchImpl: Fetch, origin: string, publicJwk: PublicJwk, device: PairDevice, signal?: AbortSignal): Promise<SelfRoom> {
  const value = await call(fetchImpl, origin + '/api/pair/self-rooms', {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicJwk, device: clampDevice(device) }),
  }) as { room?: unknown; secret?: unknown; code?: unknown };
  if (typeof value.room !== 'string' || !ROOM_ID.test(value.room) || typeof value.secret !== 'string' || !ROOM_SECRET.test(value.secret)) throw fail('invalid');
  const code = checkedCode(value.code ?? pairingCode(value.room, jwkThumbprint(publicJwk)), value.room, publicJwk);
  return { link: { origin, room: value.room, secret: value.secret }, code, thumbprint: jwkThumbprint(publicJwk) };
}

/** The school's own sign-in-and-approve page for a self-room, opened in the system browser. */
export function connectPhoneUrl(room: SelfRoom, method: string): string {
  const url = new URL('/connect-phone', room.link.origin);
  url.searchParams.set('method', method);
  url.searchParams.set('r', room.link.room);
  url.searchParams.set('s', room.link.secret);
  url.searchParams.set('k', room.thumbprint);
  return url.href;
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
    // Both spellings: the client's (`accessTokenExpiresAt`) and the contract's first (`accessExpiresAt`).
    const at = optional('accessTokenExpiresAt') ?? optional('accessExpiresAt');
    const rt = optional('refreshTokenExpiresAt') ?? optional('refreshExpiresAt');
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

export type PollOptions = {
  link: JoinLink;
  privateKey: Uint8Array;
  signal: AbortSignal;
  fetch?: Fetch;
  now?: () => number;
  intervalMs?: number;
  /** When the room was opened or claimed; the poll gives up {@link PAIRING_TIMEOUT_MS} after it. */
  startedAt?: number;
};

export type PairOptions = Omit<PollOptions, 'startedAt'> & {
  publicJwk: PublicJwk;
  device: PairDevice;
  onCode: (code: string) => void;
};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(fail('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Polls a claimed room (a scanned one or a self-room) until it is decided, and opens the credential. */
export async function waitForApproval(options: PollOptions): Promise<PairCredential> {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const started = options.startedAt ?? now();
  while (now() - started < PAIRING_TIMEOUT_MS) {
    await wait(options.intervalMs ?? 1500, options.signal);
    const room = await pollRoom(fetchImpl, options.link, options.signal);
    if (room.state === 'approved') return unsealPairing(room.sealed, options.privateKey, options.link.room);
    if (room.state === 'denied') throw fail('denied');
    if (room.state === 'expired') throw fail('expired');
  }
  throw fail('expired');
}

/** Claim, show the code, wait for approval, and open the credential. */
export async function pairPhone(options: PairOptions): Promise<PairCredential> {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  const startedAt = (options.now ?? Date.now)();
  const code = await claimRoom(fetchImpl, options.link, options.publicJwk, options.device, options.signal);
  options.onCode(code);
  return waitForApproval({ ...options, fetch: fetchImpl, startedAt });
}
