import * as ExpoCrypto from 'expo-crypto';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { base64urlnopad } from '@scure/base';
import type { Credential } from '../types';
import { CALLBACK_ORIGIN } from '../district';
import { appLink, uniqueParam } from '../security';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTEXT = encoder.encode('cloudflare-os-device-session-v1');
const ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const STATE = /^[A-Za-z0-9._~-]{16,512}$/;

export type Attempt = {
  state: string; publicKey: string; privateKey: Uint8Array; startedAt: number;
};
export type Handoff = { publicKey: string; salt: string; iv: string; ciphertext: string };

/** Separate P-256 key material for each sign-in. Never persist it or send it to the browser. */
export async function newAttempt(): Promise<Attempt> {
  let privateKey: Uint8Array;
  for (;;) {
    privateKey = await ExpoCrypto.getRandomBytesAsync(32);
    const scalar = BigInt('0x' + Array.from(privateKey, (b) => b.toString(16).padStart(2, '0')).join(''));
    if (scalar > 0n && scalar < ORDER) break;
  }
  const state = base64urlnopad.encode(await ExpoCrypto.getRandomBytesAsync(32));
  return { state, publicKey: base64urlnopad.encode(p256.getPublicKey(privateKey, false)), privateKey, startedAt: Date.now() };
}

/** Accept an app-owned universal link only, never arbitrary redirect URLs or duplicate fields. */
export function parseSessionLink(link: string, attempt: Attempt): Handoff {
  const url = appLink(link, CALLBACK_ORIGIN, '/oauthredirect');
  if (!url || Date.now() - attempt.startedAt > 120_000) {
    throw new Error('This sign-in has expired or came from an unrecognized app link.');
  }
  const params = url.searchParams;
  if (uniqueParam(params, 'cfos_callback') !== 'install-connected' || uniqueParam(params, 'state') !== attempt.state ||
      !STATE.test(attempt.state)) throw new Error('This sign-in does not match your request.');
  const publicKey = uniqueParam(params, 'publicKey');
  const salt = uniqueParam(params, 'salt');
  const iv = uniqueParam(params, 'iv');
  const ciphertext = uniqueParam(params, 'ciphertext');
  if (base64urlnopad.decode(publicKey).length !== 65 || base64urlnopad.decode(salt).length !== 32 ||
      base64urlnopad.decode(iv).length !== 12 || base64urlnopad.decode(ciphertext).length < 17) {
    throw new Error('Invalid encrypted sign-in envelope.');
  }
  return { publicKey, salt, iv, ciphertext };
}

/** WebCrypto's P-256 deriveBits returns the X coordinate; noble returns prefix+X. */
export function unseal(envelope: Handoff, attempt: Attempt): Credential {
  try {
    const point = base64urlnopad.decode(envelope.publicKey);
    if (point[0] !== 4) throw new Error('Expected an uncompressed P-256 point.');
    const shared = p256.getSharedSecret(attempt.privateKey, point);
    const key = hkdf(sha256, shared.slice(1, 33), base64urlnopad.decode(envelope.salt), CONTEXT, 32);
    const plaintext = gcm(key, base64urlnopad.decode(envelope.iv), encoder.encode(attempt.state))
      .decrypt(base64urlnopad.decode(envelope.ciphertext));
    const transfer: unknown = JSON.parse(decoder.decode(plaintext));
    key.fill(0);
    shared.fill(0);
    if (!transfer || typeof transfer !== 'object') throw new Error('Invalid transfer.');
    const value = transfer as { expiresAt?: unknown; credential?: { kind?: unknown; token?: unknown; expiresAt?: unknown } };
    if (typeof value.expiresAt !== 'number' || value.expiresAt < Date.now() ||
        value.expiresAt > attempt.startedAt + 125_000 || typeof value.credential?.token !== 'string') {
      throw new Error('This sign-in envelope is no longer valid.');
    }
    if (value.credential.kind === 'workshop' && typeof value.credential.expiresAt === 'number' &&
        value.credential.expiresAt > Date.now() && value.credential.expiresAt < Date.now() + 32 * 86_400_000) {
      return { kind: 'workshop', token: value.credential.token, expiresAt: value.credential.expiresAt };
    }
    if (value.credential.kind === 'cloudflare-access' && value.credential.token.split('.').length === 3 &&
        tokenExpiresAt({ kind: 'cloudflare-access', token: value.credential.token }) > Date.now()) {
      // Signature and audience are verified by the installation; never infer district identity from a JWT.
      return { kind: 'cloudflare-access', token: value.credential.token };
    }
    throw new Error('Unsupported session credential.');
  } catch {
    throw new Error('The encrypted school sign-in could not be verified. Please try again.');
  } finally {
    attempt.privateKey.fill(0);
  }
}

export function tokenExpiresAt(credential: Credential): number {
  if (credential.kind === 'workshop') return credential.expiresAt;
  try {
    const [, payload] = credential.token.split('.');
    if (!payload) return 0;
    const claims = JSON.parse(decoder.decode(base64urlnopad.decode(payload))) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  } catch { return 0; }
}
