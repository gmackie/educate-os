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
