// District-issued, device-bound credentials for the native app (SCHO-261, plan section 5 "Device
// credential design"). A phone holds a P-256 key pair; the district registers its public key under
// a principal and issues it a 15-minute access token and a refresh token. Every `/api/m/*` request
// carries the access token and a fresh ES256 proof signed with the device's key (in the style of
// DPoP, RFC 9449), so a token copied off the phone is useless without the key. docs/educateos/mobile.md
// describes the protocol for the client.
//
// `/api/m/*` is an Access bypass path once the one-origin cutover lands, so `serveDeviceApi` is the
// one choke point: nothing under it reaches a handler until the token, the proof and the device's
// registry row have all been checked. It then serves the request through `DistrictApp.serveAs`,
// the same routes, schemas and policy floors as the web API (ADR-0004/0005/0010), as the principal
// the device belongs to.
//
// Like the rest of the application this module uses only web-standard APIs (WebCrypto), so it runs
// in workerd, in Node under the harness, and in the tests (ADR-0009).
import { z } from "zod";
import { EducateOsError, PrincipalId, type DistrictId, type VerifiedPrincipal } from "@educateos/contracts";

/** The path prefix of the device API. */
export const DEVICE_API_PREFIX = "/api/m/";
/** The device API's own endpoint that exchanges a refresh token. It needs no access token. */
export const DEVICE_REFRESH_PATH = "/api/m/token/refresh";
/** The `Authorization` scheme a device access token is sent under. */
export const DEVICE_AUTH_SCHEME = "Device";
/** The header the per-request proof is sent in. */
export const DEVICE_PROOF_HEADER = "device-proof";
/** The `typ` a proof's JWS header must carry. */
export const DEVICE_PROOF_TYPE = "device-proof+jwt";

/** How long an access token lives. */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
/** How long a refresh token lives after it is issued; each rotation slides it. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How old (or how far ahead of the district's clock) a proof's `iat` may be. */
export const PROOF_MAX_AGE_MS = 60 * 1000;
/** How often `last_seen_at` is written at most, per device. */
export const LAST_SEEN_INTERVAL_MS = 60 * 1000;
/** The shortest `DEVICE_TOKEN_SECRET` accepted: shorter, device sign-in is disabled. */
export const MIN_DEVICE_SECRET_LENGTH = 32;

const ACCESS_TOKEN_PREFIX = "dat1";

// Records

/** A device ID: `dev_` and 128 random bits, base64url. */
export const DeviceId = z.string().regex(/^dev_[A-Za-z0-9_-]{16,64}$/).brand<"DeviceId">();
/** A device ID. */
export type DeviceId = z.infer<typeof DeviceId>;

/** What kind of device it is. */
export const DevicePlatform = z.enum(["ios", "android", "web", "other"]);
/** A device platform. */
export type DevicePlatform = z.infer<typeof DevicePlatform>;

/** A device is `active` until it is revoked; revocation is final. */
export const DeviceStatus = z.enum(["active", "revoked"]);
/** A device status. */
export type DeviceStatus = z.infer<typeof DeviceStatus>;

/** Why a device was revoked. Codes, never free text a person typed. */
export const DeviceRevocationReason = z.enum([
  /** The owner signed it out (Your devices, or the app's own sign-out). */
  "signed-out",
  /** The owner signed out everywhere. */
  "signed-out-everywhere",
  /** An administrator or operator revoked it. */
  "admin-revoked",
  /** A refresh token was used twice: the token was copied. */
  "refresh-token-reuse",
  /** The principal is no longer active in the district (deactivated, graduated). */
  "principal-inactive",
  /** Below the district's minimum app version (a forced update). */
  "app-version",
]);
/** A revocation reason. */
export type DeviceRevocationReason = z.infer<typeof DeviceRevocationReason>;

/** A P-256 public key as a JWK: only its public members are kept. */
export const DevicePublicJwk = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).transform(({ kty, crv, x, y }) => ({ kty, crv, x, y }));
/** A device public key. */
export type DevicePublicJwk = z.output<typeof DevicePublicJwk>;

/** What a device says about itself when it is registered. */
export const DeviceRegistration = z.strictObject({
  publicJwk: z.unknown(),
  label: z.string().trim().min(1).max(80),
  platform: DevicePlatform,
  model: z.string().trim().max(80).default(""),
  appVersion: z.string().trim().max(40).default(""),
});
/** A device registration, as the pairing relay or the browser sign-in path passes it. */
export type DeviceRegistration = z.input<typeof DeviceRegistration>;

/** One device in the registry. */
export interface DeviceRecord {
  id: DeviceId;
  principalId: PrincipalId;
  label: string;
  platform: DevicePlatform;
  model: string;
  appVersion: string;
  /** The RFC 7638 thumbprint of `publicJwk`. */
  keyThumbprint: string;
  publicJwk: DevicePublicJwk;
  createdAt: string;
  lastSeenAt: string;
  lastCountry: string | null;
  pushToken: string | null;
  status: DeviceStatus;
  revokedAt: string | null;
  /** The principal who revoked it, or `system`. */
  revokedBy: string | null;
  revokedReason: DeviceRevocationReason | null;
}

/** One refresh token, by the SHA-256 of its value. The value itself is never stored. */
export interface RefreshTokenRecord {
  tokenHash: string;
  deviceId: DeviceId;
  /** The chain of rotations it belongs to, from one registration. */
  family: string;
  issuedAt: string;
  usedAt: string | null;
  expiresAt: string;
}

/** Who revoked a device, why and when. */
export interface DeviceRevocation {
  /** A principal ID, or `system`. */
  by: string;
  reason: DeviceRevocationReason;
}

/** What a rotation found. */
export type RotationOutcome = "rotated" | "reused" | "missing";

/**
 * The district's device registry. Each method is one transaction: a rotation checks and marks the
 * old token and stores the new one together, so of two concurrent uses exactly one rotates.
 */
export interface DeviceStore {
  /** Stores a new device and its first refresh token. */
  register(device: DeviceRecord, refresh: RefreshTokenRecord): Promise<void>;
  get(id: DeviceId): Promise<DeviceRecord | undefined>;
  /** A principal's devices, newest first; every device when `principalId` is omitted. */
  list(principalId?: PrincipalId): Promise<DeviceRecord[]>;
  /** Records a request seen from the device. */
  touch(id: DeviceId, at: string, country: string | null): Promise<void>;
  /** Revokes the active devices among `ids`, returning those it revoked. */
  revoke(ids: readonly DeviceId[], at: string, revocation: DeviceRevocation): Promise<DeviceId[]>;
  findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | undefined>;
  /** Marks `tokenHash` used at `at` and stores `next`, unless it is missing or already used. */
  rotateRefreshToken(tokenHash: string, next: RefreshTokenRecord, at: string): Promise<RotationOutcome>;
  /**
   * Records a proof's `jti` for `deviceId` until `expiresAtMs`, forgetting expired ones. False if the
   * device already used it, which makes the proof a replay.
   */
  claimProofId(deviceId: DeviceId, jti: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
}

/** A {@link DeviceStore} in memory, for tests and the harness. */
export class InMemoryDeviceStore implements DeviceStore {
  readonly #devices = new Map<DeviceId, DeviceRecord>();
  readonly #tokens = new Map<string, RefreshTokenRecord>();
  readonly #proofs = new Map<string, number>();

  async register(device: DeviceRecord, refresh: RefreshTokenRecord): Promise<void> {
    if (this.#devices.has(device.id)) throw new EducateOsError("conflict", "That device is already registered.");
    if ([...this.#devices.values()].some((d) => d.status === "active" && d.keyThumbprint === device.keyThumbprint)) {
      throw new EducateOsError("conflict", "That device key is already registered.");
    }
    this.#devices.set(device.id, structuredClone(device));
    this.#tokens.set(refresh.tokenHash, { ...refresh });
  }

  async get(id: DeviceId): Promise<DeviceRecord | undefined> {
    const device = this.#devices.get(id);
    return device === undefined ? undefined : structuredClone(device);
  }

  async list(principalId?: PrincipalId): Promise<DeviceRecord[]> {
    return [...this.#devices.values()]
      .filter((d) => principalId === undefined || d.principalId === principalId)
      .toReversed()
      .map((d) => structuredClone(d));
  }

  async touch(id: DeviceId, at: string, country: string | null): Promise<void> {
    const device = this.#devices.get(id);
    if (device === undefined) return;
    device.lastSeenAt = at;
    if (country !== null) device.lastCountry = country;
  }

  async revoke(ids: readonly DeviceId[], at: string, revocation: DeviceRevocation): Promise<DeviceId[]> {
    const revoked: DeviceId[] = [];
    for (const id of ids) {
      const device = this.#devices.get(id);
      if (device === undefined || device.status !== "active") continue;
      Object.assign(device, { status: "revoked", revokedAt: at, revokedBy: revocation.by, revokedReason: revocation.reason });
      revoked.push(id);
    }
    return revoked;
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    const record = this.#tokens.get(tokenHash);
    return record === undefined ? undefined : { ...record };
  }

  async rotateRefreshToken(tokenHash: string, next: RefreshTokenRecord, at: string): Promise<RotationOutcome> {
    const record = this.#tokens.get(tokenHash);
    if (record === undefined) return "missing";
    if (record.usedAt !== null) return "reused";
    record.usedAt = at;
    this.#tokens.set(next.tokenHash, { ...next });
    return "rotated";
  }

  async claimProofId(deviceId: DeviceId, jti: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    for (const [key, expires] of this.#proofs) if (expires < nowMs) this.#proofs.delete(key);
    const key = `${deviceId} ${jti}`;
    if (this.#proofs.has(key)) return false;
    this.#proofs.set(key, expiresAtMs);
    return true;
  }
}

// Encoding

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The SHA-256 of `text`, base64url: a proof's `ath`, and how refresh tokens are stored. */
export async function sha256Base64url(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** The RFC 7638 JWK thumbprint of a P-256 public key: SHA-256 over its required members in order. */
export async function jwkThumbprint(jwk: DevicePublicJwk): Promise<string> {
  return sha256Base64url(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

function parseJson(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

// Tokens and proofs

/** What an access token carries. */
const AccessTokenClaims = z.strictObject({
  /** The device. */
  did: DeviceId,
  /** The principal the device belongs to. */
  pid: PrincipalId,
  /** The thumbprint of the key the device's proofs must be signed with. */
  jkt: z.string(),
  iat: z.int(),
  /** Expiry, in seconds since the epoch. */
  exp: z.int(),
});
type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

/** What a proof's JWS header must say. */
const ProofHeader = z.object({ alg: z.literal("ES256"), typ: z.literal(DEVICE_PROOF_TYPE) });

/** What a proof's payload carries. */
const ProofClaims = z.object({
  /** The request method. */
  htm: z.string(),
  /** The request path, without its query: `/api/m/...`. */
  htu: z.string(),
  /** When the proof was made, in seconds since the epoch. */
  iat: z.number(),
  /** The SHA-256 of the access token (of the refresh token, for a refresh), base64url. */
  ath: z.string(),
  /** A unique ID for this proof, which the district refuses to see twice. */
  jti: z.string().min(16).max(128),
});
type ProofClaims = z.infer<typeof ProofClaims>;

/** Why a device request was refused: the `reason` of its 401 body. */
export type DeviceAuthFailure =
  | "missing-credentials"
  | "invalid-token"
  | "token-expired"
  | "invalid-proof"
  | "proof-replayed"
  | "device-revoked"
  | "invalid-refresh-token"
  | "refresh-token-expired"
  | "refresh-token-reused";

const FAILURE_MESSAGES: Record<DeviceAuthFailure, string> = {
  "missing-credentials": "Send a device access token and a device proof.",
  "invalid-token": "The device access token is not valid.",
  "token-expired": "The device access token has expired; refresh it.",
  "invalid-proof": "The device proof is not valid for this request.",
  "proof-replayed": "The device proof was already used.",
  "device-revoked": "This device was signed out. Sign in again.",
  "invalid-refresh-token": "The refresh token is not valid.",
  "refresh-token-expired": "The refresh token has expired. Sign in again.",
  "refresh-token-reused": "The refresh token was already used, so this device was signed out. Sign in again.",
};

/** Raised inside the device module and answered as a 401 with its reason. */
class DeviceAuthError extends Error {
  readonly reason: DeviceAuthFailure;
  constructor(reason: DeviceAuthFailure) {
    super(FAILURE_MESSAGES[reason]);
    this.reason = reason;
  }
}

/** The credential set a registration or a refresh hands the device. */
export interface DeviceTokens {
  deviceId: DeviceId;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** A device API request that passed every check: the device, as stored, and who it acts as. */
export interface AuthenticatedDevice {
  device: DeviceRecord;
  principal: VerifiedPrincipal;
}

/** What {@link DeviceCredentials} is built from. */
export interface DeviceCredentialOptions {
  districtId: DistrictId;
  store: DeviceStore;
  /** `DEVICE_TOKEN_SECRET`. Missing or shorter than {@link MIN_DEVICE_SECRET_LENGTH}, device sign-in is off. */
  secret: string | undefined;
  /** Whether the principal is an active principal of this district now. */
  isActivePrincipal(principalId: PrincipalId): Promise<boolean>;
  now(): Date;
}

/**
 * The district's device token service: registration, access tokens, proofs, refresh rotation and
 * revocation. The pairing relay and the browser sign-in path call {@link registerDevice}; the device
 * API middleware calls {@link authenticate} and {@link refresh}; Your devices, administrators and
 * operators revoke through {@link revoke} and {@link revokePrincipal}.
 */
export class DeviceCredentials {
  readonly #options: DeviceCredentialOptions;
  readonly #key: Promise<CryptoKey> | undefined;

  constructor(options: DeviceCredentialOptions) {
    this.#options = options;
    const secret = options.secret ?? "";
    this.#key = secret.length < MIN_DEVICE_SECRET_LENGTH
      ? undefined
      : crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }

  /** Whether device sign-in is configured: false without a usable `DEVICE_TOKEN_SECRET`. */
  get available(): boolean {
    return this.#key !== undefined;
  }

  /** The device registry, for listings. */
  get store(): DeviceStore {
    return this.#options.store;
  }

  #hmacKey(): Promise<CryptoKey> {
    if (this.#key === undefined) throw new EducateOsError("unavailable", "Device sign-in is not configured for this district.");
    return this.#key;
  }

  /**
   * Registers a device for an active principal of this district and issues its first tokens. The
   * caller has already established who the person is (the pairing relay's approval on a signed-in
   * computer, or a browser sign-in); this function trusts `principalId` and checks only that it is
   * an active principal here.
   */
  async registerDevice(principalId: PrincipalId, registration: DeviceRegistration): Promise<DeviceTokens> {
    await this.#hmacKey();
    const input = DeviceRegistration.parse(registration);
    const publicJwk = DevicePublicJwk.safeParse(input.publicJwk);
    if (!publicJwk.success) throw new EducateOsError("validation-failed", "The device key must be a P-256 public key as a JWK.");
    await importProofKey(publicJwk.data).catch(() => {
      throw new EducateOsError("validation-failed", "The device key is not a valid P-256 public key.");
    });
    if (!await this.#options.isActivePrincipal(principalId)) {
      throw new EducateOsError("unauthenticated", "This account is not an active principal of this district.");
    }
    const at = this.#options.now();
    const device: DeviceRecord = {
      id: DeviceId.parse(`dev_${randomToken(16)}`),
      principalId,
      label: input.label,
      platform: input.platform,
      model: input.model,
      appVersion: input.appVersion,
      keyThumbprint: await jwkThumbprint(publicJwk.data),
      publicJwk: publicJwk.data,
      createdAt: at.toISOString(),
      lastSeenAt: at.toISOString(),
      lastCountry: null,
      pushToken: null,
      status: "active",
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
    };
    const refresh = await this.#newRefreshToken(device.id, randomToken(16), at);
    await this.#options.store.register(device, refresh.record);
    return this.#tokens(device, refresh, at);
  }

  /**
   * Checks a device API request: the access token's MAC and expiry, the device's registry row, and
   * the proof's signature, method, path, age, token hash and uniqueness, in that order. A device
   * whose principal is no longer active is revoked here, so reactivating the person does not bring
   * old phones back. Records the request in `last_seen_at`, at most once a minute.
   */
  async authenticate(request: Request): Promise<AuthenticatedDevice> {
    const authorization = request.headers.get("authorization") ?? "";
    const proof = request.headers.get(DEVICE_PROOF_HEADER) ?? "";
    const scheme = `${DEVICE_AUTH_SCHEME} `;
    if (!authorization.startsWith(scheme) || proof === "") throw new DeviceAuthError("missing-credentials");
    const accessToken = authorization.slice(scheme.length).trim();
    const claims = await this.#verifyAccessToken(accessToken);
    const now = this.#options.now();
    if (claims.exp * 1000 <= now.getTime()) throw new DeviceAuthError("token-expired");
    const device = await this.#options.store.get(claims.did);
    if (device === undefined || device.principalId !== claims.pid || device.keyThumbprint !== claims.jkt) {
      throw new DeviceAuthError("invalid-token");
    }
    if (device.status !== "active") throw new DeviceAuthError("device-revoked");
    await this.#verifyProof(device, request, proof, accessToken, now);
    await this.#requireActivePrincipal(device, now);
    if (now.getTime() - Date.parse(device.lastSeenAt) >= LAST_SEEN_INTERVAL_MS) {
      await this.#options.store.touch(device.id, now.toISOString(), requestCountry(request));
    }
    return { device, principal: { principalId: device.principalId, districtId: this.#options.districtId } };
  }

  /**
   * Exchanges a refresh token for new tokens. The request carries the refresh token in its JSON
   * body and a proof whose `ath` is the refresh token's hash, signed by the device's key. The old
   * token is spent; presenting it again revokes the device, since only a copy could be presented
   * after the device itself has rotated.
   */
  async refresh(request: Request, refreshToken: string): Promise<DeviceTokens> {
    await this.#hmacKey();
    const proof = request.headers.get(DEVICE_PROOF_HEADER) ?? "";
    if (refreshToken === "" || proof === "") throw new DeviceAuthError("missing-credentials");
    const tokenHash = await sha256Base64url(refreshToken);
    const record = await this.#options.store.findRefreshToken(tokenHash);
    if (record === undefined) throw new DeviceAuthError("invalid-refresh-token");
    const device = await this.#options.store.get(record.deviceId);
    if (device === undefined) throw new DeviceAuthError("invalid-refresh-token");
    if (device.status !== "active") throw new DeviceAuthError("device-revoked");
    const now = this.#options.now();
    // The proof first: a copied token alone, without the key, can neither refresh nor revoke.
    await this.#verifyProof(device, request, proof, refreshToken, now);
    if (record.usedAt !== null) await this.#reused(device, now);
    if (Date.parse(record.expiresAt) <= now.getTime()) throw new DeviceAuthError("refresh-token-expired");
    await this.#requireActivePrincipal(device, now);
    const next = await this.#newRefreshToken(device.id, record.family, now);
    const outcome = await this.#options.store.rotateRefreshToken(tokenHash, next.record, now.toISOString());
    if (outcome === "missing") throw new DeviceAuthError("invalid-refresh-token");
    if (outcome === "reused") await this.#reused(device, now);
    await this.#options.store.touch(device.id, now.toISOString(), requestCountry(request));
    return this.#tokens(device, next, now);
  }

  /** Revokes one device. Returns whether it was active. */
  async revoke(deviceId: DeviceId, revocation: DeviceRevocation): Promise<boolean> {
    const revoked = await this.#options.store.revoke([deviceId], this.#options.now().toISOString(), revocation);
    return revoked.length > 0;
  }

  /** Revokes every active device of a principal ("sign out everywhere", or an administrator's). Returns how many. */
  async revokePrincipal(principalId: PrincipalId, revocation: DeviceRevocation): Promise<number> {
    const ids = (await this.#options.store.list(principalId)).filter((d) => d.status === "active").map((d) => d.id);
    return (await this.#options.store.revoke(ids, this.#options.now().toISOString(), revocation)).length;
  }

  async #reused(device: DeviceRecord, now: Date): Promise<never> {
    await this.#options.store.revoke([device.id], now.toISOString(), { by: "system", reason: "refresh-token-reuse" });
    throw new DeviceAuthError("refresh-token-reused");
  }

  async #requireActivePrincipal(device: DeviceRecord, now: Date): Promise<void> {
    if (await this.#options.isActivePrincipal(device.principalId)) return;
    await this.#options.store.revoke([device.id], now.toISOString(), { by: "system", reason: "principal-inactive" });
    throw new DeviceAuthError("device-revoked");
  }

  async #newRefreshToken(deviceId: DeviceId, family: string, at: Date): Promise<{ token: string; record: RefreshTokenRecord }> {
    const token = randomToken(32);
    return {
      token,
      record: {
        tokenHash: await sha256Base64url(token),
        deviceId,
        family,
        issuedAt: at.toISOString(),
        usedAt: null,
        expiresAt: new Date(at.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      },
    };
  }

  async #tokens(device: DeviceRecord, refresh: { token: string; record: RefreshTokenRecord }, at: Date): Promise<DeviceTokens> {
    const iat = Math.floor(at.getTime() / 1000);
    const exp = iat + ACCESS_TOKEN_TTL_MS / 1000;
    const claims: AccessTokenClaims = { did: device.id, pid: device.principalId, jkt: device.keyThumbprint, iat, exp };
    const body = `${ACCESS_TOKEN_PREFIX}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await this.#hmacKey(), encoder.encode(body)));
    return {
      deviceId: device.id,
      accessToken: `${body}.${base64url(mac)}`,
      accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.record.expiresAt,
    };
  }

  async #verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== ACCESS_TOKEN_PREFIX) throw new DeviceAuthError("invalid-token");
    const mac = fromBase64url(parts[2]!);
    if (mac === undefined) throw new DeviceAuthError("invalid-token");
    const valid = await crypto.subtle.verify("HMAC", await this.#hmacKey(), mac, encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!valid) throw new DeviceAuthError("invalid-token");
    const claims = AccessTokenClaims.safeParse(parseJson(fromBase64url(parts[1]!)));
    if (!claims.success) throw new DeviceAuthError("invalid-token");
    return claims.data;
  }

  async #verifyProof(device: DeviceRecord, request: Request, proof: string, token: string, now: Date): Promise<void> {
    const claims = await verifyProofSignature(device.publicJwk, proof);
    if (claims === undefined) throw new DeviceAuthError("invalid-proof");
    const url = new URL(request.url);
    const ageMs = now.getTime() - claims.iat * 1000;
    if (
      claims.htm !== request.method
      || claims.htu !== url.pathname
      || ageMs > PROOF_MAX_AGE_MS
      || ageMs < -PROOF_MAX_AGE_MS
      || claims.ath !== await sha256Base64url(token)
    ) {
      throw new DeviceAuthError("invalid-proof");
    }
    // Kept until no proof with this iat could be accepted any more.
    const claimed = await this.#options.store.claimProofId(device.id, claims.jti, claims.iat * 1000 + PROOF_MAX_AGE_MS, now.getTime());
    if (!claimed) throw new DeviceAuthError("proof-replayed");
  }
}

function importProofKey(jwk: DevicePublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { ...jwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/** A compact ES256 JWS's claims, if it is signed by `jwk` and well formed. */
async function verifyProofSignature(jwk: DevicePublicJwk, compact: string): Promise<ProofClaims | undefined> {
  const parts = compact.split(".");
  if (parts.length !== 3) return undefined;
  const header = ProofHeader.safeParse(parseJson(fromBase64url(parts[0]!)));
  const claims = ProofClaims.safeParse(parseJson(fromBase64url(parts[1]!)));
  const signature = fromBase64url(parts[2]!);
  if (!header.success || !claims.success || signature === undefined || signature.length !== 64) return undefined;
  try {
    const key = await importProofKey(jwk);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, encoder.encode(`${parts[0]}.${parts[1]}`));
    return valid ? claims.data : undefined;
  } catch {
    return undefined;
  }
}

/** The country Cloudflare located the request in, if it says. */
function requestCountry(request: Request): string | null {
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const country = typeof cf?.country === "string" ? cf.country : request.headers.get("cf-ipcountry");
  return country !== null && /^[A-Z0-9]{2}$/.test(country) ? country : null;
}

// The device API middleware

/** What {@link serveDeviceApi} reaches. */
export interface DeviceApiOptions {
  credentials: DeviceCredentials;
  /** Serves one `/api` request as an already verified principal: `DistrictApp.serveAs`. */
  serveAs(principal: VerifiedPrincipal, request: Request): Promise<Response>;
}

/** Whether a path is under the device API, which only {@link serveDeviceApi} may serve. */
export function isDeviceApiPath(pathname: string): boolean {
  return pathname === "/api/m" || pathname.startsWith(DEVICE_API_PREFIX);
}

/** The web API path a device API path maps to: `/api/m/<rest>` is `/api/<rest>`. */
export function webApiPath(pathname: string): string {
  return `/api/${pathname.slice(DEVICE_API_PREFIX.length)}`;
}

const RefreshBody = z.strictObject({ refreshToken: z.string().min(1).max(512) });

function deviceJson(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function refused(reason: DeviceAuthFailure): Response {
  return deviceJson(
    { code: "unauthenticated", reason, message: FAILURE_MESSAGES[reason] },
    401,
    { "www-authenticate": `${DEVICE_AUTH_SCHEME} error="${reason}"` },
  );
}

/**
 * Serves one request under `/api/m/`: the device API's one choke point. Without device sign-in
 * configured every request is a 503 `device-auth-unavailable`. `POST /api/m/token/refresh`
 * exchanges a refresh token. Every other request must carry a valid access token, a valid proof
 * and an active device, or it is a 401 before anything else runs; it is then served as
 * `/api/<rest>` for the device's principal, through the web API's own routes and policy.
 */
export async function serveDeviceApi(request: Request, options: DeviceApiOptions): Promise<Response> {
  const { credentials } = options;
  try {
    if (!credentials.available) {
      return deviceJson({ code: "unavailable", reason: "device-auth-unavailable", message: "Device sign-in is not configured for this district." }, 503);
    }
    const url = new URL(request.url);
    if (url.pathname === DEVICE_REFRESH_PATH && request.method === "POST") {
      const body = RefreshBody.safeParse(await request.json().catch(() => undefined));
      if (!body.success) return refused("missing-credentials");
      return deviceJson(await credentials.refresh(request, body.data.refreshToken), 200);
    }
    const { principal } = await credentials.authenticate(request);
    const forwarded = new Headers(request.headers);
    forwarded.delete("authorization");
    forwarded.delete(DEVICE_PROOF_HEADER);
    const mapped = new URL(url);
    mapped.pathname = webApiPath(url.pathname);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return await options.serveAs(principal, new Request(mapped, {
      method: request.method,
      headers: forwarded,
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
    }));
  } catch (error) {
    if (error instanceof DeviceAuthError) return refused(error.reason);
    throw error;
  } finally {
    if (!request.bodyUsed) await request.body?.cancel();
  }
}
