export const CALLBACK_ORIGIN = 'https://mobile.educateos.io';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * Development builds also accept `http://localhost:<port>`, the mobile dev district
 * (`pnpm educateos:mobile-district`, SCHO-272). Release builds (and the tests) never do.
 */
const DEV_LOOPBACK = typeof __DEV__ !== 'undefined' && __DEV__;

/** A school address must name exactly one HTTPS origin, never a redirectable subresource. */
export function strictOrigin(value: string, allowLoopback = DEV_LOOPBACK): string {
  const input = value.trim();
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Enter a full HTTPS address from your school.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname) {
    throw new Error('Use the school origin only, with no path, account, or query.');
  }
  if (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('A verified HTTPS school address is required.');
  }
  if (url.port && url.protocol === 'https:' && url.port !== '443') throw new Error('Use the standard HTTPS port.');
  return url.origin;
}

/** A typed school address: "learn.example.org" → "https://learn.example.org"; otherwise one exact HTTPS origin. */
export function normalizeAddress(value: string): string {
  const text = value.trim();
  return strictOrigin(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : 'https://' + text);
}

export function trustedUrl(value: string, origin: string): boolean {
  try {
    const u = new URL(value);
    return u.origin === origin && (u.protocol === 'https:' || origin.startsWith('http://localhost:'));
  } catch { return false; }
}

export function appLink(link: string, callbackOrigin: string, expectedPath: string): URL | null {
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:' || u.origin !== callbackOrigin || u.pathname !== expectedPath ||
        u.username || u.password || u.hash && expectedPath === '/oauthredirect') return null;
    return u;
  } catch { return null; }
}

export function uniqueParam(params: URLSearchParams, key: string): string {
  const values = params.getAll(key);
  if (values.length !== 1 || !values[0]) throw new Error('The sign-in response was incomplete.');
  return values[0];
}

/** Enrollment links carry public school addresses only, never credentials or sign-in tokens. */
export function parseEnrollmentLink(value: string): { name: string; portal: string; workshop: string } {
  let url = new URL(value);
  if (url.origin === CALLBACK_ORIGIN && url.pathname === '/enroll' && !url.search && !url.username && !url.password) {
    url = new URL('educateos://enroll?' + url.hash.slice(1));
  }
  if (url.protocol !== 'educateos:' || url.hostname !== 'enroll' ||
      (url.pathname !== '' && url.pathname !== '/') || url.username || url.password || url.port || url.hash ||
      [...url.searchParams.keys()].some(key => !['name', 'portal', 'workshop'].includes(key))) {
    throw new Error('Use a school setup link provided by your school.');
  }
  const name = uniqueParam(url.searchParams, 'name').trim();
  if (name.length < 2 || name.length > 90) throw new Error('The school setup link needs a school name.');
  const portal = strictOrigin(uniqueParam(url.searchParams, 'portal'));
  const workshop = strictOrigin(uniqueParam(url.searchParams, 'workshop'));
  return { name, portal, workshop };
}

const ROOM = /^[A-Za-z0-9_-]{8,128}$/;
const ROOM_SECRET = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * The one-origin pairing QR: `https://mobile.educateos.io/j#o=<origin>&r=<room>&s=<secret>`, or the
 * `educateos://j?o=…` form the landing page hands to the app. The school is one exact HTTPS origin;
 * the room and secret only let this phone claim a two-minute room, which the person still approves.
 */
export function parseJoinLink(value: string): { origin: string; room: string; secret: string } {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('This is not an EducateOS school code.'); }
  let params: URLSearchParams;
  if (url.protocol === 'https:' && url.origin === CALLBACK_ORIGIN && url.pathname === '/j' &&
      !url.search && !url.username && !url.password && url.hash.length > 1) {
    params = new URLSearchParams(url.hash.slice(1));
  } else if (url.protocol === 'educateos:' && url.hostname === 'j' && (url.pathname === '' || url.pathname === '/') &&
      !url.username && !url.password && !url.port && !url.hash) {
    params = url.searchParams;
  } else {
    throw new Error('This is not an EducateOS school code.');
  }
  if ([...params.keys()].some((key) => !['o', 'r', 's'].includes(key))) throw new Error('This school code is not valid.');
  const origin = strictOrigin(uniqueParam(params, 'o'));
  const room = uniqueParam(params, 'r'), secret = uniqueParam(params, 's');
  if (!ROOM.test(room) || !ROOM_SECRET.test(secret)) throw new Error('This school code is not valid.');
  return { origin, room, secret };
}

/** A QR grants only an expiring pairing attempt; both devices must still confirm the transfer. */
export function parsePairingLink(value: string): { name: string; portal: string; workshop: string; id: string; secret: string } {
  let url = new URL(value);
  if (url.origin === CALLBACK_ORIGIN && url.pathname === '/pair-phone' && !url.search && !url.username && !url.password) {
    url = new URL('educateos://pair?' + url.hash.slice(1));
  }
  if (url.protocol !== 'educateos:' || url.hostname !== 'pair' || url.username || url.password || url.port ||
      url.hash || (url.pathname !== '' && url.pathname !== '/') ||
      [...url.searchParams.keys()].some(key => !['name', 'portal', 'workshop', 'id', 'secret'].includes(key))) {
    throw new Error('Invalid phone pairing code.');
  }
  const id = uniqueParam(url.searchParams, 'id'), secret = uniqueParam(url.searchParams, 'secret');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || !/^[0-9a-f]{64}$/.test(secret)) throw new Error('Invalid phone pairing code.');
  const details = new URLSearchParams();
  for (const key of ['name', 'portal', 'workshop']) details.set(key, uniqueParam(url.searchParams, key));
  return { ...parseEnrollmentLink('educateos://enroll?' + details), id, secret };
}
