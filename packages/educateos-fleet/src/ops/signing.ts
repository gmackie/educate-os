// Signed ops requests (SCHO-263): how an admin edition (admin.educateos.io, or the OSS admin in the
// district's own account) calls a district's `/api/ops/*`. Each request is signed with the admin's
// Ed25519 ops key over its method, path and query, a hash of its body, a timestamp, a nonce, the
// key ID and the acting operator. The district looks the key up by ID (never trusting a key sent
// with the request), checks the signature, the age (±60 s), that the nonce is new, and that the
// key holds the route's scope.
//
// Web Crypto only, so the same code runs in workerd and Node (ADR-0009).
import { z } from "zod";
import { toBase64Url } from "../encoding.ts";
import { Ed25519PublicKey, Ed25519Signature, KeyId, keyIdFor, type SigningIdentity, verifySignature } from "../identity.ts";
import { matchOpsRoute, type OpsRouteMatch, type OpsScope } from "./scopes.ts";

/** The context string at the start of the signed bytes, so an ops signature verifies as nothing else. */
export const OPS_PROTOCOL = "educateos-ops/v1";

/** The headers a signed ops request carries. */
export const OPS_HEADERS = {
  signature: "educateos-ops-signature",
  keyId: "educateos-ops-key-id",
  timestamp: "educateos-ops-ts",
  nonce: "educateos-ops-nonce",
  operator: "educateos-ops-operator",
} as const;

/** How far a request's timestamp may be from the verifier's clock, either way. */
export const OPS_MAX_SKEW_SECONDS = 60;

/** The largest request body the verifier reads. Ops commands are small JSON objects. */
export const OPS_MAX_BODY_BYTES = 64 * 1024;

/** A request nonce: 16 to 64 base64url characters. The signer uses 16 random bytes. */
export const OpsNonce = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "expected a base64url nonce");

/**
 * Who, at the admin edition, asked for the request: the operator's verified email or Access subject.
 * Printable ASCII without spaces, so it fits a header and the signed string unambiguously.
 */
export const OpsOperator = z.string().regex(/^[\x21-\x7e]{1,320}$/, "expected a printable operator label");

/** A Unix time in whole seconds, as the timestamp header carries it. */
const Timestamp = z.string().regex(/^\d{1,12}$/);

/** The fields a signature covers, in signing order. */
export interface OpsSignedFields {
  method: string;
  /** The path and query exactly as sent: `url.pathname + url.search`. */
  target: string;
  /** Base64url SHA-256 of the body bytes (of nothing, for a request without one). */
  bodyHash: string;
  /** Unix seconds. */
  timestamp: number;
  nonce: string;
  keyId: string;
  operator: string;
}

/** Base64url SHA-256 of `bytes`. */
export async function sha256Base64Url(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * The exact bytes a signature covers: each field on its own line, after the protocol context. No
 * field can contain a newline (the method is letters, the target is a URL's encoded path and query,
 * the others are validated), so the lines can't be shifted into one another.
 */
export function opsSigningBytes(fields: OpsSignedFields): Uint8Array<ArrayBuffer> {
  const lines = [
    OPS_PROTOCOL,
    fields.method.toUpperCase(),
    fields.target,
    fields.bodyHash,
    String(fields.timestamp),
    fields.nonce,
    fields.keyId,
    fields.operator,
  ];
  if (lines.some((line) => line.includes("\n"))) throw new Error("ops signature fields may not contain newlines");
  return new TextEncoder().encode(lines.join("\n")).slice();
}

function bodyBytes(body: string | Uint8Array<ArrayBuffer> | undefined): Uint8Array<ArrayBuffer> {
  if (body === undefined) return new Uint8Array(0);
  return typeof body === "string" ? new TextEncoder().encode(body).slice() : body;
}

/** What {@link signOpsRequest} signs. */
export interface OpsRequestToSign {
  method: string;
  /** The full URL the request goes to. Only its path and query are signed. */
  url: string | URL;
  /** The body exactly as it will be sent. */
  body?: string | Uint8Array<ArrayBuffer>;
  /** The acting operator (see {@link OpsOperator}). */
  operator: string;
  /** The signing time. Defaults to now. */
  now?: Date;
  /** The nonce. Defaults to 16 random bytes; tests pass one to replay a request. */
  nonce?: string;
}

/** Signs one request, returning the headers to send with it. */
export async function signOpsRequest(identity: SigningIdentity, request: OpsRequestToSign): Promise<Record<string, string>> {
  const url = new URL(request.url);
  const operator = OpsOperator.parse(request.operator);
  const nonce = OpsNonce.parse(request.nonce ?? toBase64Url(crypto.getRandomValues(new Uint8Array(16))));
  const timestamp = Math.floor((request.now ?? new Date()).getTime() / 1000);
  const fields: OpsSignedFields = {
    method: request.method,
    target: `${url.pathname}${url.search}`,
    bodyHash: await sha256Base64Url(bodyBytes(request.body)),
    timestamp,
    nonce,
    keyId: identity.keyId,
    operator,
  };
  return {
    [OPS_HEADERS.signature]: await identity.sign(opsSigningBytes(fields)),
    [OPS_HEADERS.keyId]: identity.keyId,
    [OPS_HEADERS.timestamp]: String(timestamp),
    [OPS_HEADERS.nonce]: nonce,
    [OPS_HEADERS.operator]: operator,
  };
}

/** One admin edition's key as a district registered it. */
export interface OpsKey {
  keyId: string;
  publicKey: Ed25519PublicKey;
  /** The scopes the district granted this key. */
  scopes: readonly OpsScope[];
}

/** Where the verifier finds registered keys. A removed or opted-out admin's key is simply absent. */
export interface OpsKeyring {
  find(keyId: KeyId): Promise<OpsKey | undefined> | OpsKey | undefined;
}

/**
 * Remembers nonces for as long as their request could still be accepted. `claim` records a nonce
 * and reports whether it was new; it must be atomic, so two copies of one request can't both win.
 */
export interface NonceStore {
  claim(keyId: string, nonce: string, expiresAtMs: number): Promise<boolean>;
}

/** A {@link NonceStore} in memory, for tests and single-isolate use. Forgets expired nonces as it goes. */
export class InMemoryNonceStore implements NonceStore {
  readonly #seen = new Map<string, number>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async claim(keyId: string, nonce: string, expiresAtMs: number): Promise<boolean> {
    const now = this.#now().getTime();
    for (const [key, expiry] of this.#seen) if (expiry < now) this.#seen.delete(key);
    const key = `${keyId}\n${nonce}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, expiresAtMs);
    return true;
  }

  /** How many nonces are remembered. */
  get size(): number {
    return this.#seen.size;
  }
}

/** Why a request was refused. Logged by the district; the caller only sees the status. */
export type OpsRejectionReason =
  | "missing-signature"
  | "malformed-signature"
  | "stale"
  | "unknown-key"
  | "body-too-large"
  | "bad-signature"
  | "replayed"
  | "unknown-route"
  | "scope-denied";

const REJECTION_STATUS: Record<OpsRejectionReason, 400 | 401 | 403 | 404 | 413> = {
  "missing-signature": 401,
  "malformed-signature": 401,
  "stale": 401,
  "unknown-key": 401,
  "body-too-large": 413,
  "bad-signature": 401,
  "replayed": 401,
  "unknown-route": 404,
  "scope-denied": 403,
};

/** A request that verified. */
export interface OpsAccepted {
  ok: true;
  keyId: KeyId;
  operator: string;
  timestamp: number;
  match: OpsRouteMatch;
  /** The body bytes the signature covered, already read from the request. */
  body: Uint8Array<ArrayBuffer>;
}

/** A request that didn't, with the HTTP status to answer. */
export interface OpsRejected {
  ok: false;
  status: 400 | 401 | 403 | 404 | 413;
  reason: OpsRejectionReason;
}

/** The verifier's verdict on a request. */
export type OpsVerification = OpsAccepted | OpsRejected;

/** What {@link createOpsVerifier} is given. */
export interface OpsVerifierOptions {
  keys: OpsKeyring;
  nonces: NonceStore;
  now?: () => Date;
  maxSkewSeconds?: number;
  maxBodyBytes?: number;
}

/** Checks signed ops requests at a district. */
export interface OpsVerifier {
  /** Verifies a request, consuming its body. Never throws for anything the request contains. */
  verify(request: Request): Promise<OpsVerification>;
}

const reject = (reason: OpsRejectionReason): OpsRejected => ({ ok: false, status: REJECTION_STATUS[reason], reason });

async function readBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return undefined;
  if (request.body === null) return new Uint8Array(0);
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > limit ? undefined : bytes;
}

/**
 * A verifier over a keyring and a nonce store. The checks run cheapest first, and the nonce is
 * claimed only once the signature holds, so nobody can burn another caller's nonces. Every validly
 * signed request consumes its nonce, even one then refused for its route or scope.
 */
export function createOpsVerifier(options: OpsVerifierOptions): OpsVerifier {
  const now = options.now ?? (() => new Date());
  const maxSkew = options.maxSkewSeconds ?? OPS_MAX_SKEW_SECONDS;
  const maxBody = options.maxBodyBytes ?? OPS_MAX_BODY_BYTES;
  return {
    async verify(request) {
      const header = (name: string) => request.headers.get(name);
      const raw = {
        signature: header(OPS_HEADERS.signature),
        keyId: header(OPS_HEADERS.keyId),
        timestamp: header(OPS_HEADERS.timestamp),
        nonce: header(OPS_HEADERS.nonce),
        operator: header(OPS_HEADERS.operator),
      };
      if (Object.values(raw).some((value) => value === null || value === "")) return reject("missing-signature");
      const signature = Ed25519Signature.safeParse(raw.signature);
      const keyId = KeyId.safeParse(raw.keyId);
      const timestamp = Timestamp.safeParse(raw.timestamp);
      const nonce = OpsNonce.safeParse(raw.nonce);
      const operator = OpsOperator.safeParse(raw.operator);
      if (!signature.success || !keyId.success || !timestamp.success || !nonce.success || !operator.success) {
        return reject("malformed-signature");
      }

      const sentAt = Number(timestamp.data);
      const nowSeconds = now().getTime() / 1000;
      if (Math.abs(nowSeconds - sentAt) > maxSkew) return reject("stale");

      const key = await options.keys.find(keyId.data);
      // The key must be the one its ID names, so a registered ID can't front for another key.
      if (key === undefined || key.keyId !== keyId.data || (await keyIdFor(key.publicKey)) !== keyId.data) {
        return reject("unknown-key");
      }

      const body = await readBody(request, maxBody);
      if (body === undefined) return reject("body-too-large");

      const url = new URL(request.url);
      const fields: OpsSignedFields = {
        method: request.method,
        target: `${url.pathname}${url.search}`,
        bodyHash: await sha256Base64Url(body),
        timestamp: sentAt,
        nonce: nonce.data,
        keyId: keyId.data,
        operator: operator.data,
      };
      if (!(await verifySignature(key.publicKey, signature.data, opsSigningBytes(fields)))) return reject("bad-signature");

      // Remembered until the request could no longer pass the age check.
      if (!(await options.nonces.claim(keyId.data, nonce.data, (sentAt + maxSkew) * 1000 + 1000))) return reject("replayed");

      const match = matchOpsRoute(request.method, url.pathname);
      if (match === undefined) return reject("unknown-route");
      if (!key.scopes.includes(match.route.scope)) return reject("scope-denied");

      return { ok: true, keyId: keyId.data, operator: operator.data, timestamp: sentAt, match, body };
    },
  };
}
