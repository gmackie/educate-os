// The demo videos under /assets/videos/ (SCHO-343) need byte-range responses: Safari, on a Mac and
// on an iPhone, will not play an MP4 or WebM that is served whole with a 200, and static assets
// answer a Range request that way. These paths reach the Worker first, which serves the file from
// the assets binding and cuts the requested range out of it. Every file is under the 25 MiB asset
// limit, so holding one in memory is safe.

/** Worker-first routes for the videos. */
export const VIDEO_PATHS = ['/assets/videos/*'];
const PREFIX = '/assets/videos/';
/** Files are renamed when they change (each name carries a version), so a browser may keep one for good. */
const CACHE = 'public, max-age=31536000, immutable';

/**
 * Answers a request for a video file with the whole file or the byte range it asks for. Anything
 * else is not for this handler, and gets `undefined`.
 * @param {Request} request
 * @param {{ASSETS: {fetch: (request: Request) => Promise<Response>}}} env
 * @returns {Promise<Response | undefined>}
 */
export async function handleVideo(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {status: 405, headers: {Allow: 'GET, HEAD'}});
  }
  // The assets binding ignores Range, so ask it for the whole file.
  const whole = await env.ASSETS.fetch(new Request(url, {method: 'GET'}));
  if (whole.status !== 200) return whole;
  const headers = new Headers(whole.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', CACHE);
  headers.delete('Content-Encoding');
  const body = new Uint8Array(await whole.arrayBuffer());
  const size = body.byteLength;
  const range = parseRange(request.headers.get('Range'), size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`);
    headers.set('Content-Length', '0');
    return new Response(null, {status: 416, headers});
  }
  const [start, end] = range ?? [0, size - 1];
  const part = range ? body.subarray(start, end + 1) : body;
  headers.set('Content-Length', String(part.byteLength));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  return new Response(request.method === 'HEAD' ? null : part, {status: range ? 206 : 200, headers});
}

/**
 * The single byte range a Range header asks for, as inclusive [start, end]; `undefined` when there
 * is no usable header (serve the whole file), or 'unsatisfiable'. Several ranges in one header are
 * answered with the whole file, which RFC 9110 allows.
 * @param {string | null} header
 * @param {number} size
 * @returns {[number, number] | 'unsatisfiable' | undefined}
 */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  let start, end;
  if (match[1] === '') {
    // A suffix: the last N bytes.
    const n = Number(match[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(match[1]);
    if (match[2] !== '' && Number(match[2]) < start) return undefined;
    if (start >= size) return 'unsatisfiable';
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return [start, end];
}
