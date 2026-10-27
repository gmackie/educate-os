import * as WebBrowser from 'expo-web-browser';
import type { District, Session } from '../types';
import { CALLBACK_ORIGIN } from '../district';
import { newAttempt, parseSessionLink, unseal, type Attempt } from './crypto';
import { storeSession } from './session';

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
    if (result.type === 'cancel' || result.type === 'dismiss') throw new Error('Sign-in was cancelled.');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let url: string;
    try {
      url = result.type === 'success' ? result.url : await Promise.race([
        viaLink,
        new Promise<string>((_, reject) => { timeout = setTimeout(() =>
          reject(new Error('The school's app-link sign-in timed out.')), 120_000); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
    const credential = unseal(parseSessionLink(url, attempt), attempt);
    return await storeSession(district, credential);
  } finally {
    attempt.privateKey.fill(0);
    activeAttempt = null;
    onLink = null;
    // Do not save provider or installation credentials in history or AsyncStorage.
  }
}
