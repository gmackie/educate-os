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
