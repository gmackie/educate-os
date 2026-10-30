// Helpers for the pairing relay tests (SCHO-261): browser requests over the test IdP's sign-in, the
// phone's room requests, and the phone's half of the sealing, written from the contract
// (docs/educateos/mobile.md, "Pairing v2") with WebCrypto alone, independently of src/pairing.ts.
import type { TestPhone } from "./device-support.ts";

const encoder = new TextEncoder();
const ORIGIN = "https://district.example";

/** A browser request to the relay, signed in with `token` (none when undefined). */
export function webRequest(token: string | undefined, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(method === "POST" ? { "content-type": "application/json", origin: ORIGIN } : {}),
      ...headers,
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}

/** The phone's claim. */
export function claimRequest(room: string, secret: string | undefined, phone: TestPhone, device: Record<string, unknown> = phoneDevice()): Request {
  return new Request(`${ORIGIN}/api/pair/rooms/${room}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(secret === undefined ? {} : { secret }), publicJwk: phone.publicJwk, device }),
  });
}

/** The phone's poll. */
export function pollRequest(room: string, secret: string | undefined): Request {
  return new Request(`${ORIGIN}/api/pair/rooms/${room}${secret === undefined ? "" : `?secret=${encodeURIComponent(secret)}`}`);
}

export function phoneDevice(): { label: string; platform: "ios"; model: string; appVersion: string } {
  return { label: "Ava's iPhone", platform: "ios", model: "iPhone 16", appVersion: "1.4.0" };
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The RFC 7638 thumbprint of the phone's key. */
export async function thumbprintOf(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical))));
}

/** The pairing code, as the contract derives it. */
export async function expectedCode(room: string, jwk: JsonWebKey): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(room + await thumbprintOf(jwk))));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from(digest.subarray(0, 8), (b) => alphabet[b % 36]).join("");
}

/** Opens sealed tokens with the phone's private key, as the app does. */
export async function unseal(phone: TestPhone, room: string, sealed: { epk: JsonWebKey; iv: string; ct: string }): Promise<Record<string, string>> {
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", phone.keys.privateKey);
  const own = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epk = await crypto.subtle.importKey("jwk", { kty: sealed.epk.kty, crv: sealed.epk.crv, x: sealed.epk.x, y: sealed.epk.y }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, own, 256);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const keyBytes = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(room), info: encoder.encode("educateos-pair-v2") }, ikm, 256);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const iv = fromBase64url(sealed.iv);
  if (iv.length !== 12) throw new Error("the IV is not 12 bytes");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, fromBase64url(sealed.ct));
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>;
}
