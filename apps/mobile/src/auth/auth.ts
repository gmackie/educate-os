import * as ExpoCrypto from 'expo-crypto';
import { p256 } from '@noble/curves/nist.js';
import { base64urlnopad } from '@scure/base';
import * as WebBrowser from 'expo-web-browser';
import type { District, Session } from '../types';
import { CALLBACK_ORIGIN } from '../district';
import { parseSessionLink, unseal, type Attempt } from './crypto';
import { storeSession } from './session';
import { authResponseUrl } from './response';

const ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

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


let activeAttempt: Attempt | null = null;
let onLink: ((url: string) => void) | null = null;

export function consumeIncomingUrl(url: string): void {
  // Native universal links can reach Linking independently from openAuthSessionAsync.
  onLink?.(url);
}

export async function signIn(district: District): Promise<Session> {
  if (activeAttempt) throw new Error('Finish or cancel the current sign-in first.');
  const attempt = await newAttempt();
  activeAttempt = attempt;
  const landing = new URL('/', district.workshop);
  landing.searchParams.set('cfos_native_state', attempt.state);
  landing.searchParams.set('cfos_native_key', attempt.publicKey);
  const callback = CALLBACK_ORIGIN + '/oauthredirect';
  let resolveLink!: (url: string) => void;
  const viaLink = new Promise<string>((resolve) => { resolveLink = resolve; });
  onLink = (url) => {
    try {
      const u = new URL(url);
      if (u.origin === CALLBACK_ORIGIN && u.pathname === '/oauthredirect') {
        parseSessionLink(url, attempt);
        resolveLink(url);
      }
    } catch { /* The auth session's own result will handle invalid links. */ }
  };
  try {
    // iOS 17.4+: preferUniversalLinks requires a signed, associated domain.
    // Android: Chrome Custom Tabs will return through a verified App Link.
    const result = await WebBrowser.openAuthSessionAsync(landing.href, callback, { preferUniversalLinks: true });
    const url = await authResponseUrl(result, viaLink);
    const credential = unseal(parseSessionLink(url, attempt), attempt);
    return await storeSession(district, credential);
  } finally {
    attempt.privateKey.fill(0);
    activeAttempt = null;
    onLink = null;
    // Do not save provider or installation credentials in history or AsyncStorage.
  }
}

/** Pair through the public ciphertext relay; the Workshop still owns credential creation and consent. */
export async function signInFromComputer(district: District, pairing: { id: string; secret: string }, onCode: (code: string) => void, signal: AbortSignal): Promise<Session> {
  if (activeAttempt) throw new Error('Finish or cancel the current sign-in first.');
  const attempt = await newAttempt();
  attempt.state = `pair-v1.${pairing.id}.${attempt.state}`;
  activeAttempt = attempt;
  const endpoint = CALLBACK_ORIGIN + '/pairings/' + pairing.id;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(endpoint + path, { method: body ? 'POST' : 'GET', signal,
      headers: { Authorization: 'Bearer ' + pairing.secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error('This computer pairing expired or was already used. Create a new code.');
    return response.json();
  };
  try {
    const room = await request('');
    if (!room.school || room.school.portal !== district.portal || room.school.workshop !== district.workshop || room.school.name !== district.name) {
      throw new Error('The computer and phone school details do not match.');
    }
    const code = (await ExpoCrypto.digestStringAsync(ExpoCrypto.CryptoDigestAlgorithm.SHA256, attempt.state + '.' + attempt.publicKey)).slice(0, 8).toUpperCase();
    await request('/claim', { state: attempt.state, publicKey: attempt.publicKey });
    onCode(code);
    while (Date.now() - attempt.startedAt < 120_000 && Date.now() < room.expiresAt) {
      const result = await request('');
      if (result.callback) {
        signal.throwIfAborted();
        return await storeSession(district, unseal(parseSessionLink(result.callback, attempt), attempt));
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('Computer pairing cancelled.')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1500);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error('Computer pairing expired. Create a new code on the computer.');
  } finally {
    attempt.privateKey.fill(0);
    activeAttempt = null;
  }
}
