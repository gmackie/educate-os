/**
 * Incoming links. expo-router hands every URL that opens the app to app/+native-intent.tsx, which
 * classifies it here. School codes are parsed once and kept in memory (never in a route param,
 * history or storage), and the app navigates to a screen that takes them from here.
 */
import { CALLBACK_ORIGIN, parseEnrollmentLink, parseJoinLink, parsePairingLink } from './security.ts';

export type JoinLink = ReturnType<typeof parseJoinLink>;
export type Enrollment = ReturnType<typeof parseEnrollmentLink>;
export type LegacyPairing = ReturnType<typeof parsePairingLink>;

export type Incoming =
  | { kind: 'join'; join: JoinLink }
  | { kind: 'enroll'; enrollment: Enrollment }
  | { kind: 'legacy-pair'; pairing: LegacyPairing }
  | { kind: 'auth-callback' }
  | { kind: 'invalid'; message: string }
  | { kind: 'route' };

function is(url: URL, path: string, scheme: string): boolean {
  return (url.protocol === 'https:' && url.origin === CALLBACK_ORIGIN && url.pathname === path) ||
    (url.protocol === 'educateos:' && url.hostname === scheme);
}

export function classifyIncomingUrl(value: string): Incoming {
  let url: URL;
  try { url = new URL(value); } catch { return { kind: 'route' }; }
  try {
    if (is(url, '/j', 'j')) return { kind: 'join', join: parseJoinLink(value) };
    if (is(url, '/enroll', 'enroll')) return { kind: 'enroll', enrollment: parseEnrollmentLink(value) };
    if (is(url, '/pair-phone', 'pair')) return { kind: 'legacy-pair', pairing: parsePairingLink(value) };
  } catch (e) {
    return { kind: 'invalid', message: e instanceof Error ? e.message : 'This school code is not valid.' };
  }
  if (url.origin === CALLBACK_ORIGIN && (url.pathname === '/oauthredirect' || url.pathname === '/authpopup')) {
    return { kind: 'auth-callback' };
  }
  if (url.protocol === 'https:' && url.origin === CALLBACK_ORIGIN) return { kind: 'invalid', message: 'This link is not for this version of EducateOS.' };
  return { kind: 'route' };
}

export type PendingLink = Exclude<Incoming, { kind: 'auth-callback' } | { kind: 'route' }>;

let pending: PendingLink | null = null;
const listeners = new Set<(link: PendingLink) => void>();

export function setPendingLink(link: PendingLink): void {
  pending = link;
  for (const listener of listeners) listener(link);
}
/** Takes the waiting link, once. */
export function takePendingLink(): PendingLink | null {
  const link = pending;
  pending = null;
  return link;
}
export function onPendingLink(listener: (link: PendingLink) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
