import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import CookieManager from '@preeternal/react-native-cookie-manager';
import type { Credential, District, Session } from '../types';
import { tokenExpiresAt } from './crypto';

const PREFIX = 'educateos.session.';

async function keyFor(district: District): Promise<string> {
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, district.id);
  return PREFIX + hash;
}

export function sessionActive(session: Session): boolean {
  return tokenExpiresAt(session.credential) - 30_000 > Date.now();
}

export async function storeSession(district: District, credential: Credential): Promise<Session> {
  const session: Session = { district, credential, confirmedAt: Date.now() };
  await SecureStore.setItemAsync(await keyFor(district), JSON.stringify(session), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return session;
}

export async function restoreSession(district: District): Promise<Session | null> {
  try {
    const raw = await SecureStore.getItemAsync(await keyFor(district));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const s = value as Session;
    if (s.district?.id !== district.id || !s.credential?.token || !sessionActive(s)) {
      await SecureStore.deleteItemAsync(await keyFor(district));
      return null;
    }
    return s;
  } catch { return null; }
}

/** A per-origin HttpOnly cookie for deployments protected by Cloudflare Access. */
export async function prepareWebView(session: Session): Promise<void> {
  if (session.credential.kind !== 'cloudflare-access') return;
  const host = new URL(session.district.workshop).hostname;
  const ok = await CookieManager.set(session.district.workshop, {
    name: 'CF_Authorization',
    value: session.credential.token,
    domain: host,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expires: new Date(tokenExpiresAt(session.credential)).toISOString(),
  }, { iosCookieStore: 'webKit' });
  if (!ok) throw new Error('Unable to prepare your secure web session.');
}

export async function clearSession(district: District): Promise<void> {
  await SecureStore.deleteItemAsync(await keyFor(district));
  // Clear all embedded-webview cookies on account switch, not the system browser.
  await CookieManager.clearAll(true);
}
