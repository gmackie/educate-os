export const CALLBACK_ORIGIN = 'https://mobile.educateos.io';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A school address must name exactly one HTTPS origin, never a redirectable subresource. */
export function strictOrigin(value: string, allowLoopback = false): string {
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
