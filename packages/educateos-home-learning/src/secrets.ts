// The two secrets home learning keeps (ADR-0016): the family's adult PIN, stored as a salted
// PBKDF2-SHA-256 hash, and child-session tokens, of which only a SHA-256 digest is stored. Both use
// Web Crypto only, so the same code runs in Workers, Node and browsers.
import { z } from "zod";
import type { StoredPin } from "./model.ts";

/** A PIN: four to eight digits. */
export const Pin = z.string().regex(/^\d{4,8}$/, "use 4 to 8 digits");

/** Workers caps PBKDF2 at 100,000 iterations. */
export const PIN_ITERATIONS = 100_000;
/** Failed tries before the PIN locks. */
export const PIN_MAX_FAILURES = 5;
/** How long a locked PIN stays locked, in milliseconds. */
export const PIN_LOCK_MS = 15 * 60 * 1000;

const encoder = new TextEncoder();

/** Base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Hashes a new PIN for storage. */
export async function hashPin(pin: string, iterations = PIN_ITERATIONS): Promise<StoredPin> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: base64url(salt), hash: base64url(await derive(Pin.parse(pin), salt, iterations)), iterations, failures: 0 };
}

/** Whether `pin` matches a stored PIN, compared in constant time. Ignores the lock: see the service. */
export async function pinMatches(stored: StoredPin, pin: string): Promise<boolean> {
  if (!Pin.safeParse(pin).success) return false;
  const actual = await derive(pin, fromBase64url(stored.salt), stored.iterations);
  const expected = fromBase64url(stored.hash);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

/** A fresh 256-bit token, base64url. */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The digest a token is stored and found by. */
export async function tokenDigest(token: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}

/** A random ID body: lowercase letters and digits. */
export function idBody(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
