// The phone pairing relay, v2 (SCHO-261, ADR-0014): how a phone gets its district-issued device
// credential (devices.ts) without the person typing a password into the app. docs/educateos/mobile.md
// ("Pairing v2") is the contract; the mobile client (apps/mobile/src/api/pairing.ts) implements the
// other end.
//
// 1. A signed-in browser opens a room (`POST /api/pair/rooms`) and shows its QR code.
// 2. The phone claims the room with the room secret from the QR code and the public half of a new
//    device key. Both screens show the same eight-character code.
// 3. The person approves on the computer. The district registers the device for that person and
//    seals its tokens to the phone's key (ECDH P-256, HKDF-SHA-256, AES-256-GCM), so the relay
//    never hands a bearer credential to anyone without the key.
// 4. The phone's next poll collects the sealed tokens, once.
//
// A phone with no computer nearby makes a "self-room" (`POST /api/pair/self-rooms`), already claimed
// by its key, and opens `/connect-phone` in the system browser, where the person signs in and
// approves it.
//
// `/api/pair/*` is an Access bypass path once the one-origin cutover lands. The phone's endpoints are
// authenticated by the room secret alone (compared in constant time; five wrong secrets expire the
// room); the browser's endpoints need the district's own web sign-in, as `/api/me` does, and answer
// only the room's creator. Rooms live in the district's storage (`PairRoomStore`), so a pairing
// survives the Durable Object restarting halfway through.
//
// Like devices.ts this module uses only web-standard APIs (WebCrypto), so it runs in workerd, in
// Node under the harness, and in the tests (ADR-0009).
import { z } from "zod";
import { EducateOsError, type PrincipalId, type PrincipalKind } from "@educateos/contracts";
import { DevicePlatform, DevicePublicJwk, jwkThumbprint, sha256Base64url, type DeviceCredentials, type DeviceId } from "./devices.ts";

/** The path prefix of the pairing relay. */
export const PAIR_API_PREFIX = "/api/pair/";
/** The page a phone without a computer nearby opens in the system browser. */
export const CONNECT_PHONE_PATH = "/connect-phone";
/** Where a QR code (and the connect page, when it is done) sends the phone: the app's join link. */
export const PAIR_JOIN_URL = "https://mobile.educateos.io/j";
/** The HKDF `info` the sealing key is derived with. */
export const PAIR_HKDF_INFO = "educateos-pair-v2";
/** How long a room waits for a phone, and then for the person's approval. */
export const PAIR_ROOM_TTL_MS = 2 * 60 * 1000;
/** How many wrong secrets a room takes before it expires. */
export const PAIR_MAX_BAD_SECRETS = 5;
/** How many self-rooms may be open at once: anyone can make one, so they are capped. */
export const PAIR_MAX_OPEN_SELF_ROOMS = 100;
/** How long a finished room is kept, so a late poll is told what happened rather than "unknown". */
const PAIR_ROOM_RETENTION_MS = 60 * 60 * 1000;
/** The alphabet of the pairing code. */
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const ROOM_ID = /^[A-Za-z0-9_-]{8,128}$/;
const ROOM_SECRET = /^[A-Za-z0-9_-]{16,256}$/;

// Records

/**
 * Where a room is. `approving` is held while the device is registered; `consumed` once the phone has
 * collected its sealed tokens. A room past its `expiresAt` is expired whatever it says.
 */
export const PairRoomState = z.enum(["waiting", "claimed", "approving", "approved", "consumed", "denied", "expired"]);
/** A room state. */
export type PairRoomState = z.infer<typeof PairRoomState>;

/** What a phone says about itself when it claims a room. */
export const PairDevice = z.object({
  label: z.string().trim().min(1).max(80),
  platform: DevicePlatform,
  model: z.string().trim().max(80).default(""),
  appVersion: z.string().trim().max(40).default(""),
}).transform(({ label, platform, model, appVersion }) => ({ label, platform, model, appVersion }));
/** A pairing device description. */
export type PairDevice = z.output<typeof PairDevice>;

/** A device's tokens, sealed to its key. */
export const SealedCredential = z.strictObject({
  epk: z.strictObject({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string(), y: z.string() }),
  iv: z.string(),
  ct: z.string(),
});
/** Sealed tokens. */
export type SealedCredential = z.infer<typeof SealedCredential>;

/** One pairing room. Its secret is kept only as a SHA-256 hash. */
export const PairRoom = z.strictObject({
  id: z.string().regex(ROOM_ID),
  /** Bumped on every change: each change is a compare-and-set on it. */
  version: z.int().nonnegative(),
  /** `web`: opened by a signed-in browser. `self`: opened by a phone, claimed from the start. */
  kind: z.enum(["web", "self"]),
  /** Who opened the room; for a self-room, who approved or declined it, once someone has. */
  creatorPrincipalId: z.string().nullable(),
  secretHash: z.string(),
  state: PairRoomState,
  /** Milliseconds since the epoch. */
  createdAt: z.int(),
  /** Milliseconds since the epoch. */
  expiresAt: z.int(),
  badSecrets: z.int().nonnegative(),
  claim: z.strictObject({
    publicJwk: DevicePublicJwk,
    keyThumbprint: z.string(),
    code: z.string().regex(/^[A-Z0-9]{8}$/),
    device: z.strictObject({ label: z.string(), platform: DevicePlatform, model: z.string(), appVersion: z.string() }),
  }).nullable(),
  sealed: SealedCredential.nullable(),
  deviceId: z.string().nullable(),
});
/** A pairing room. */
export type PairRoom = z.infer<typeof PairRoom>;

/**
 * Where pairing rooms are kept. Every change is a compare-and-set on the room's version, so of two
 * concurrent claims, approvals or polls exactly one wins.
 */
export interface PairRoomStore {
  get(id: string): Promise<PairRoom | undefined>;
  /** Stores a new room. */
  insert(room: PairRoom): Promise<void>;
  /** Replaces the room with `next` if it is still at `next.version - 1`. False if it moved on. */
  replace(next: PairRoom): Promise<boolean>;
  /** Expires the open (waiting or claimed) rooms `creatorPrincipalId` opened. */
  expireOpen(creatorPrincipalId: string, nowMs: number): Promise<void>;
  /** How many self-rooms are unexpired and unapproved. */
  countOpenSelfRooms(nowMs: number): Promise<number>;
  /** Forgets the rooms that expired before `beforeMs`. */
  purge(beforeMs: number): Promise<void>;
}

const OPEN_STATES: readonly PairRoomState[] = ["waiting", "claimed"];

/** A {@link PairRoomStore} in memory, for tests and the harness. */
export class InMemoryPairRoomStore implements PairRoomStore {
  readonly #rooms = new Map<string, PairRoom>();

  async get(id: string): Promise<PairRoom | undefined> {
    const room = this.#rooms.get(id);
    return room === undefined ? undefined : structuredClone(room);
  }

  async insert(room: PairRoom): Promise<void> {
    if (this.#rooms.has(room.id)) throw new EducateOsError("conflict", "That pairing room already exists.");
    this.#rooms.set(room.id, structuredClone(room));
  }

  async replace(next: PairRoom): Promise<boolean> {
    const current = this.#rooms.get(next.id);
    if (current === undefined || current.version !== next.version - 1) return false;
    this.#rooms.set(next.id, structuredClone(next));
    return true;
  }

  async expireOpen(creatorPrincipalId: string, nowMs: number): Promise<void> {
    for (const room of this.#rooms.values()) {
      if (room.creatorPrincipalId === creatorPrincipalId && OPEN_STATES.includes(room.state) && room.expiresAt > nowMs) {
        Object.assign(room, { state: "expired", expiresAt: nowMs, version: room.version + 1 });
      }
    }
  }

  async countOpenSelfRooms(nowMs: number): Promise<number> {
    return [...this.#rooms.values()].filter((r) => r.kind === "self" && r.state === "claimed" && r.expiresAt > nowMs).length;
  }

  async purge(beforeMs: number): Promise<void> {
    for (const [id, room] of this.#rooms) if (room.expiresAt < beforeMs) this.#rooms.delete(id);
  }
}

// Encoding and crypto

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Whether two strings are equal, in time that depends only on their lengths. */
function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}

/**
 * The eight-character pairing code both screens show: SHA-256 over the UTF-8 bytes of the room ID
 * followed by the device key's RFC 7638 thumbprint (base64url), each of its first eight bytes taken
 * modulo 36 into `A`–`Z` then `0`–`9`.
 */
export async function pairingCode(roomId: string, keyThumbprint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(roomId + keyThumbprint)));
  return Array.from(digest.subarray(0, 8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

/** What is sealed to the phone. */
export interface PairCredential {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  principalId: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

/**
 * Seals `credential` to the phone's key: ECDH P-256 between a fresh ephemeral key and `publicJwk`
 * (the shared secret is the X coordinate), HKDF-SHA-256 with the room ID's UTF-8 bytes as salt and
 * {@link PAIR_HKDF_INFO} as info into an AES-256-GCM key, a random 12-byte IV, no additional data.
 * The plaintext names the expiries both as the client reads them (`accessTokenExpiresAt`) and as the
 * contract first wrote them (`accessExpiresAt`).
 */
export async function sealCredential(publicJwk: DevicePublicJwk, roomId: string, credential: PairCredential): Promise<SealedCredential> {
  const phonePublic = await crypto.subtle.importKey("jwk", { ...publicJwk, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: phonePublic }, ephemeral.privateKey, 256);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(roomId), info: encoder.encode(PAIR_HKDF_INFO) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({
    ...credential,
    accessExpiresAt: credential.accessTokenExpiresAt,
    refreshExpiresAt: credential.refreshTokenExpiresAt,
  }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const { x, y } = await crypto.subtle.exportKey("jwk", ephemeral.publicKey);
  return { epk: { kty: "EC", crv: "P-256", x: x!, y: y! }, iv: base64url(iv), ct: base64url(ct) };
}

/** Parses a phone's public key and checks it is a point on P-256. */
async function phoneKey(value: unknown): Promise<DevicePublicJwk> {
  const parsed = DevicePublicJwk.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", "The device key must be a P-256 public key as a JWK.");
  await crypto.subtle.importKey("jwk", { ...parsed.data, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []).catch(() => {
    throw new EducateOsError("validation-failed", "The device key is not a valid P-256 public key.");
  });
  return parsed.data;
}

// The relay

/** Who a browser request is signed in as. */
export interface WebPrincipal {
  principalId: PrincipalId;
  kind: PrincipalKind;
  displayName: string;
}

/** What {@link PairingRelay} is built from. */
export interface PairingRelayOptions {
  store: PairRoomStore;
  devices: DeviceCredentials;
  /**
   * The principal the request is signed in as by the district's web sign-in (as `/api/me` resolves
   * it), or undefined for a request that proves no identity. Throws for a sign-in that is nobody's.
   */
  resolveWeb(request: Request): Promise<WebPrincipal | undefined>;
  now(): Date;
}

/** The state a phone's poll reports. */
type PhoneState = "waiting" | "approved" | "denied" | "expired";
/** The state the creator's status reports. */
type BrowserState = "waiting" | "claimed" | "approved" | "denied" | "expired";

const ClaimBody = z.object({ secret: z.string(), publicJwk: z.unknown(), device: PairDevice });
const SelfRoomBody = z.object({ publicJwk: z.unknown(), device: PairDevice });
const DecisionBody = z.object({ secret: z.string().optional() });

function pairJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const gone = () => pairJson({ code: "gone", message: "This pairing code has expired or was already used. Make a new one." }, 410);
const wrongSecret = () => pairJson({ code: "forbidden", message: "That is not this pairing room's secret." }, 403);
const noRoom = () => pairJson({ code: "not-found", message: "No such pairing room." }, 404);

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 16 * 1024) throw new EducateOsError("validation-failed", "The request body is too large.");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EducateOsError("validation-failed", "The request body is not valid JSON.");
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", "The pairing request is invalid.");
  return parsed.data;
}

/** Builds a QR code's join link. */
export function joinLink(origin: string, room: string, secret: string): string {
  return `${PAIR_JOIN_URL}#o=${encodeURIComponent(origin)}&r=${room}&s=${secret}`;
}

/** Whether a path is under the pairing relay. */
export function isPairApiPath(pathname: string): boolean {
  return pathname === "/api/pair" || pathname.startsWith(PAIR_API_PREFIX);
}

/** The pairing relay: `/api/pair/*` and the `/connect-phone` page. */
export class PairingRelay {
  readonly #options: PairingRelayOptions;

  constructor(options: PairingRelayOptions) {
    this.#options = options;
  }

  #nowMs(): number {
    return this.#options.now().getTime();
  }

  /** The state a room is in now: past its expiry, an unfinished room is expired. */
  #effective(room: PairRoom): PairRoomState {
    if (room.state === "consumed" || room.state === "expired") return room.state;
    return room.expiresAt <= this.#nowMs() ? "expired" : room.state;
  }

  /** Serves one request under `/api/pair/`. */
  async serve(request: Request): Promise<Response> {
    try {
      if (!this.#options.devices.available) {
        return pairJson({ code: "unavailable", reason: "device-auth-unavailable", message: "Phone sign-in is not configured for this district." }, 503);
      }
      const url = new URL(request.url);
      const segments = url.pathname.slice(PAIR_API_PREFIX.length).split("/");
      const method = request.method;
      if (segments.length === 1 && segments[0] === "rooms" && method === "POST") return await this.#createRoom(request);
      if (segments.length === 1 && segments[0] === "self-rooms" && method === "POST") return await this.#createSelfRoom(request);
      if (segments[0] === "rooms" && segments.length >= 2 && segments.length <= 3) {
        const roomId = segments[1]!;
        const action = segments[2];
        if (action === undefined && method === "GET") return await this.#poll(roomId, url.searchParams.get("secret"));
        if (action === "claim" && method === "POST") return await this.#claim(roomId, request);
        if (action === "status" && method === "GET") return await this.#status(roomId, request);
        if ((action === "approve" || action === "deny") && method === "POST") return await this.#decide(roomId, request, action);
      }
      return pairJson({ code: "not-found", message: "No such route." }, 404);
    } finally {
      if (!request.bodyUsed) await request.body?.cancel();
    }
  }

  // Browser side

  /** The signed-in person, or a 401. Refuses a cross-site POST, so another site cannot approve for them. */
  async #webPrincipal(request: Request): Promise<WebPrincipal> {
    if (request.method === "POST") {
      const origin = request.headers.get("origin");
      if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
        throw new EducateOsError("forbidden", "Pairing requests must come from this district's own pages.");
      }
    }
    const principal = await this.#options.resolveWeb(request);
    if (principal === undefined) throw new EducateOsError("unauthenticated", "Sign in with this district's identity provider.");
    if (principal.kind === "service") throw new EducateOsError("forbidden", "Only people pair phones.");
    return principal;
  }

  async #createRoom(request: Request): Promise<Response> {
    const principal = await this.#webPrincipal(request);
    const now = this.#nowMs();
    const { store } = this.#options;
    await store.purge(now - PAIR_ROOM_RETENTION_MS);
    // One open room per person: a new QR code retires the last one.
    await store.expireOpen(principal.principalId, now);
    const secret = randomToken(32);
    const room: PairRoom = {
      id: randomToken(16),
      version: 0,
      kind: "web",
      creatorPrincipalId: principal.principalId,
      secretHash: await sha256Base64url(secret),
      state: "waiting",
      createdAt: now,
      expiresAt: now + PAIR_ROOM_TTL_MS,
      badSecrets: 0,
      claim: null,
      sealed: null,
      deviceId: null,
    };
    await store.insert(room);
    return pairJson({
      room: room.id,
      secret,
      qr: joinLink(new URL(request.url).origin, room.id, secret),
      expiresAt: new Date(room.expiresAt).toISOString(),
    }, 201);
  }

  async #status(roomId: string, request: Request): Promise<Response> {
    const principal = await this.#webPrincipal(request);
    const room = await this.#room(roomId);
    if (room === undefined || room.creatorPrincipalId !== principal.principalId) return noRoom();
    const state = this.#effective(room);
    const shown: BrowserState = state === "approving" ? "claimed" : state === "consumed" ? "approved" : state;
    return pairJson({
      state: shown,
      ...(room.claim === null ? {} : { code: room.claim.code, device: room.claim.device }),
    }, 200);
  }

  async #decide(roomId: string, request: Request, action: "approve" | "deny"): Promise<Response> {
    const principal = await this.#webPrincipal(request);
    const body = parse(DecisionBody, await readBody(request));
    let room = await this.#room(roomId);
    if (room === undefined) return noRoom();
    if (room.creatorPrincipalId === null) {
      // A self-room is nobody's until someone who holds its secret (the connect page) decides it.
      if (body.secret === undefined) return noRoom();
      if (!await this.#secretMatches(room, body.secret)) return wrongSecret();
      room = (await this.#room(roomId))!;
    } else if (room.creatorPrincipalId !== principal.principalId) {
      return noRoom();
    }
    const state = this.#effective(room);
    if (state === "expired" || state === "consumed") return gone();
    if (action === "deny") {
      if (state !== "waiting" && state !== "claimed") return pairJson({ code: "conflict", message: "This pairing room was already decided." }, 409);
      const next: PairRoom = { ...room, version: room.version + 1, state: "denied", creatorPrincipalId: principal.principalId };
      if (!await this.#options.store.replace(next)) return pairJson({ code: "conflict", message: "This pairing room changed; try again." }, 409);
      return pairJson({ state: "denied" }, 200);
    }
    if (state !== "claimed" || room.claim === null) {
      return pairJson({ code: "conflict", message: state === "waiting" ? "No phone has joined yet." : "This pairing room was already decided." }, 409);
    }
    const claim = room.claim;
    const approving: PairRoom = { ...room, version: room.version + 1, state: "approving", creatorPrincipalId: principal.principalId };
    if (!await this.#options.store.replace(approving)) return pairJson({ code: "conflict", message: "This pairing room changed; try again." }, 409);

    let sealed: SealedCredential;
    let deviceId: DeviceId;
    try {
      const tokens = await this.#options.devices.registerDevice(principal.principalId, { publicJwk: claim.publicJwk, ...claim.device });
      deviceId = tokens.deviceId;
      sealed = await sealCredential(claim.publicJwk, room.id, { ...tokens, principalId: principal.principalId });
    } catch (error) {
      // Back to claimed, so the person can see why and try again or decline.
      await this.#options.store.replace({ ...approving, version: approving.version + 1, state: "claimed", creatorPrincipalId: room.creatorPrincipalId });
      throw error;
    }
    const approved: PairRoom = {
      ...approving,
      version: approving.version + 1,
      state: "approved",
      // The phone polls every second or two; it has as long again to collect them.
      expiresAt: this.#nowMs() + PAIR_ROOM_TTL_MS,
      sealed,
      deviceId,
    };
    if (!await this.#options.store.replace(approved)) {
      await this.#options.devices.revoke(deviceId, { by: "system", reason: "signed-out" });
      return pairJson({ code: "conflict", message: "This pairing room changed; try again." }, 409);
    }
    return pairJson({ deviceId }, 200);
  }

  // Phone side

  async #claim(roomId: string, request: Request): Promise<Response> {
    const raw = await readBody(request);
    const room = await this.#room(roomId);
    if (room === undefined) return noRoom();
    const secret = (raw as { secret?: unknown } | null)?.secret;
    if (!await this.#secretMatches(room, secret)) return wrongSecret();
    const current = (await this.#room(roomId))!;
    const state = this.#effective(current);
    if (state === "expired" || state === "consumed") return gone();
    if (state !== "waiting") return pairJson({ code: "conflict", message: "Another phone already joined this pairing room." }, 409);
    const body = parse(ClaimBody, raw);
    const publicJwk = await phoneKey(body.publicJwk);
    const keyThumbprint = await jwkThumbprint(publicJwk);
    const code = await pairingCode(current.id, keyThumbprint);
    const next: PairRoom = {
      ...current,
      version: current.version + 1,
      state: "claimed",
      expiresAt: this.#nowMs() + PAIR_ROOM_TTL_MS,
      claim: { publicJwk, keyThumbprint, code, device: body.device },
    };
    if (!await this.#options.store.replace(next)) return pairJson({ code: "conflict", message: "Another phone already joined this pairing room." }, 409);
    return pairJson({ code }, 200);
  }

  async #poll(roomId: string, secret: string | null): Promise<Response> {
    const room = await this.#room(roomId);
    if (room === undefined) return noRoom();
    if (!await this.#secretMatches(room, secret)) return wrongSecret();
    const current = (await this.#room(roomId))!;
    const state = this.#effective(current);
    if (state === "consumed") return gone();
    if (state === "approved" && current.sealed !== null) {
      // Handed over once: the room is spent the moment it is read.
      const consumed: PairRoom = { ...current, version: current.version + 1, state: "consumed", sealed: null };
      if (!await this.#options.store.replace(consumed)) return gone();
      return pairJson({ state: "approved", sealed: current.sealed }, 200);
    }
    const shown: PhoneState = state === "denied" || state === "expired" ? state : "waiting";
    return pairJson({ state: shown }, 200);
  }

  async #createSelfRoom(request: Request): Promise<Response> {
    const body = parse(SelfRoomBody, await readBody(request));
    const publicJwk = await phoneKey(body.publicJwk);
    const now = this.#nowMs();
    const { store } = this.#options;
    await store.purge(now - PAIR_ROOM_RETENTION_MS);
    if (await store.countOpenSelfRooms(now) >= PAIR_MAX_OPEN_SELF_ROOMS) {
      return pairJson({ code: "unavailable", reason: "too-many-rooms", message: "Too many phones are connecting right now. Try again in a minute." }, 429);
    }
    const id = randomToken(16);
    const secret = randomToken(32);
    const keyThumbprint = await jwkThumbprint(publicJwk);
    const code = await pairingCode(id, keyThumbprint);
    await store.insert({
      id,
      version: 0,
      kind: "self",
      creatorPrincipalId: null,
      secretHash: await sha256Base64url(secret),
      state: "claimed",
      createdAt: now,
      expiresAt: now + PAIR_ROOM_TTL_MS,
      badSecrets: 0,
      claim: { publicJwk, keyThumbprint, code, device: body.device },
      sealed: null,
      deviceId: null,
    });
    return pairJson({ room: id, secret, code, expiresAt: new Date(now + PAIR_ROOM_TTL_MS).toISOString() }, 201);
  }

  // Rooms and secrets

  async #room(roomId: string): Promise<PairRoom | undefined> {
    return ROOM_ID.test(roomId) ? this.#options.store.get(roomId) : undefined;
  }

  /**
   * Whether `secret` is the room's, compared in constant time. A wrong one counts against the room,
   * and the fifth expires it, so a room secret cannot be guessed online.
   */
  async #secretMatches(room: PairRoom, secret: unknown): Promise<boolean> {
    const hash = typeof secret === "string" && ROOM_SECRET.test(secret) ? await sha256Base64url(secret) : "";
    if (constantTimeEqual(hash, room.secretHash)) return true;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.#options.store.get(room.id);
      if (current === undefined) break;
      const badSecrets = current.badSecrets + 1;
      const lockedOut = badSecrets >= PAIR_MAX_BAD_SECRETS && current.state !== "consumed";
      const next: PairRoom = {
        ...current,
        version: current.version + 1,
        badSecrets,
        ...(lockedOut ? { state: "expired" as const, sealed: null, expiresAt: Math.min(current.expiresAt, this.#nowMs()) } : {}),
      };
      if (await this.#options.store.replace(next)) break;
    }
    return false;
  }

  // The connect page

  /**
   * `GET /connect-phone?method=…&r=<room>&s=<secret>&k=<key thumbprint>`: behind the district's
   * sign-in, asks the signed-in person to approve the phone that opened self-room `r`, showing the
   * code the phone shows. Approve and Deny post to the room's approve and deny endpoints; either way
   * the page then sends the browser to the app's join link, and the phone carries on polling.
   */
  async connectPhone(request: Request): Promise<Response> {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return page("Not allowed", "<p>Open this page from the EducateOS app.</p>", 405);
      if (!this.#options.devices.available) {
        return page("Phone sign-in is off", "<p>Your school hasn't turned on phone sign-in yet.</p>", 503);
      }
      const url = new URL(request.url);
      const roomId = url.searchParams.get("r") ?? "";
      const secret = url.searchParams.get("s") ?? "";
      const thumbprint = url.searchParams.get("k") ?? "";
      if (!ROOM_ID.test(roomId) || !ROOM_SECRET.test(secret) || !/^[A-Za-z0-9_-]{43}$/.test(thumbprint)) {
        return page("This link can't be used", "<p>Start again from the EducateOS app on your phone.</p>", 400);
      }
      let principal: WebPrincipal | undefined;
      try {
        principal = await this.#options.resolveWeb(request);
      } catch (error) {
        if (error instanceof EducateOsError) {
          return page("Your account isn't set up here", `<p>${escapeHtml(error.message)}</p>`, 403);
        }
        throw error;
      }
      if (principal === undefined) return page("Sign in first", "<p>Sign in to your school, then open this page again from the app.</p>", 401);
      if (principal.kind === "service") return page("Only people pair phones", "<p>Sign in as yourself to connect a phone.</p>", 403);

      const expired = () => page("This request has expired", "<p>Start again from the EducateOS app on your phone.</p>", 410);
      const room = await this.#room(roomId);
      if (room === undefined || room.kind !== "self") return expired();
      if (!await this.#secretMatches(room, secret)) return expired();
      const current = (await this.#room(roomId))!;
      if (this.#effective(current) !== "claimed" || current.claim === null) return expired();
      if (!constantTimeEqual(current.claim.keyThumbprint, thumbprint)) {
        return page("This link doesn't match your phone", "<p>Start again from the EducateOS app on your phone.</p>", 400);
      }

      const nonce = randomToken(16);
      const next = joinLink(url.origin, roomId, secret);
      const { device, code } = current.claim;
      const model = device.model === "" ? "" : `<span class="muted">${escapeHtml(device.model)}</span>`;
      const body = `
<main id="pair" data-room="${escapeHtml(roomId)}" data-secret="${escapeHtml(secret)}" data-next="${escapeHtml(next)}">
  <h1>Approve this phone?</h1>
  <p class="muted">Signed in as ${escapeHtml(principal.displayName || "you")}. Only approve a phone you are holding.</p>
  <div class="device"><strong>${escapeHtml(device.label)}</strong>${model}</div>
  <p>Check that your phone shows this code:</p>
  <p class="code" aria-label="Pairing code ${code.split("").join(" ")}">${code.slice(0, 4)}·${code.slice(4)}</p>
  <div class="actions">
    <button type="button" id="approve" class="primary">Approve</button>
    <button type="button" id="deny">Deny</button>
  </div>
  <p id="message" role="status" class="muted"></p>
</main>
<script nonce="${nonce}">
(() => {
  const root = document.getElementById("pair");
  const message = document.getElementById("message");
  const buttons = [document.getElementById("approve"), document.getElementById("deny")];
  async function decide(action) {
    for (const b of buttons) b.disabled = true;
    message.textContent = action === "approve" ? "Connecting your phone…" : "Declining…";
    try {
      const response = await fetch("/api/pair/rooms/" + encodeURIComponent(root.dataset.room) + "/" + action, {
        method: "POST", credentials: "same-origin", redirect: "manual",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ secret: root.dataset.secret }),
      });
      if (response.ok) { message.textContent = "Done. Returning to the app…"; location.replace(root.dataset.next); return; }
      const problem = await response.json().catch(() => ({}));
      message.textContent = problem.message || "That didn't work. Start again from the app.";
    } catch {
      message.textContent = "We couldn't reach your school. Check your connection and try again.";
    }
    for (const b of buttons) b.disabled = false;
  }
  buttons[0].addEventListener("click", () => decide("approve"));
  buttons[1].addEventListener("click", () => decide("deny"));
})();
</script>`;
      return page("Approve this phone?", body, 200, nonce);
    } finally {
      if (!request.bodyUsed) await request.body?.cancel();
    }
  }
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

// Neutral colours in the district UI's (Kumo's) manner, light or dark as the device prefers.
const PAGE_CSS = `
:root { color-scheme: light dark; --bg: #f7f7f8; --surface: #fff; --text: #1b1b1f; --muted: #5d5d66; --line: #dedee3; --brand: #2458ac; --brand-text: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #111114; --surface: #1c1c21; --text: #ececf1; --muted: #a0a0ab; --line: #2e2e36; --brand: #7aa5ff; --brand-text: #0b1530; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; }
main { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
h1 { font-size: 1.375rem; margin: 0 0 8px; }
.muted { color: var(--muted); font-size: 0.9375rem; }
.device { display: flex; flex-direction: column; padding: 12px 14px; border: 1px solid var(--line); border-radius: 8px; margin: 16px 0; }
.code { font: 600 2rem/1.2 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.08em; text-align: center; margin: 8px 0 20px; }
.actions { display: flex; gap: 12px; }
button { flex: 1; font: inherit; font-weight: 600; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text); cursor: pointer; }
button.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-text); }
button:disabled { opacity: 0.6; cursor: default; }
button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
`;

/** A small server-rendered page under a strict CSP: only its own nonced style and script run. */
function page(title: string, body: string, status: number, nonce: string = randomToken(16)): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · EducateOS</title>
<style nonce="${nonce}">${PAGE_CSS}</style>
</head>
<body>
${body.trimStart().startsWith("<main") ? body : `<main><h1>${escapeHtml(title)}</h1>${body}</main>`}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}
