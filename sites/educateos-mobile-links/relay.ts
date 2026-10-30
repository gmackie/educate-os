import { DurableObject } from 'cloudflare:workers';
import { acceptCallback, hash, makeClaim, schoolDetails, token, validToken, type Pairing } from './pairing';

export type RelayEnv = { PAIRINGS: DurableObjectNamespace<PhonePairing>; ASSETS: Fetcher };
async function limitedText(request: Request, limit: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error('Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });

/** Two-minute relay: private keys and plaintext installation credentials never enter it. */
export class PhonePairing extends DurableObject<RelayEnv> {
  async alarm() { await this.ctx.storage.deleteAll(); }
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(() => this.handle(request));
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/rate') {
      const now = Date.now();
      const rate = await this.ctx.storage.get<{ count: number; until: number }>('rate');
      const next = rate && rate.until > now ? { ...rate, count: rate.count + 1 } : { count: 1, until: now + 300_000 };
      await this.ctx.storage.put('rate', next);
      await this.ctx.storage.setAlarm(next.until);
      return json({}, next.count > 10 ? 429 : 200);
    }
    if (request.method === 'POST' && Number(request.headers.get('Content-Length') || 0) > 16384) return json({}, 413);
    try {
      if (url.pathname === '/create') {
        if (await this.ctx.storage.get('pair')) return json({}, 409);
        const text = await limitedText(request, 2048);
        if (text.length > 2048) return json({}, 413);
        const school = schoolDetails(JSON.parse(text));
        const browserToken = token(), phoneToken = token();
        const pair: Pairing = { school, expiresAt: Date.now() + 120_000, browserHash: await hash(browserToken), phoneHash: await hash(phoneToken) };
        await this.ctx.storage.put('pair', pair);
        await this.ctx.storage.setAlarm(pair.expiresAt);
        return json({ browserToken, phoneToken, school, expiresAt: pair.expiresAt });
      }
      const pair = await this.ctx.storage.get<Pairing>('pair');
      if (!pair || pair.expiresAt <= Date.now()) { await this.ctx.storage.deleteAll(); return json({}, 410); }
      if (url.pathname === '/callback') {
        // The fixed callback receives only state-bound ciphertext from Workshop's single-use handoff.
        const callback = new URL(await limitedText(request, 16384));
        if (callback.origin !== 'https://mobile.educateos.io' || callback.pathname !== '/oauthredirect') return json({}, 400);
        acceptCallback(pair, callback);
        await this.ctx.storage.put('pair', pair);
        return json({ delivered: true });
      }
      const supplied = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
      if (!validToken(supplied)) return json({}, 403);
      const digest = await hash(supplied);
      const browser = digest === pair.browserHash, phone = digest === pair.phoneHash;
      if (!browser && !phone) return json({}, 403);
      if (request.method === 'GET') {
        if (phone && pair.callback) {
          await this.ctx.storage.deleteAll();
          return json({ callback: pair.callback });
        }
        return json({ school: pair.school, expiresAt: pair.expiresAt, claim: browser ? pair.claim : undefined, approved: pair.approved || false });
      }
      const text = await limitedText(request, 2048);
      if (text.length > 2048) return json({}, 413);
      if (url.pathname.endsWith('/claim') && phone && !pair.claim) {
        pair.claim = await makeClaim(url.pathname.split('/')[2], JSON.parse(text));
      } else if (url.pathname.endsWith('/approve') && browser && pair.claim && !pair.approved) {
        const { code } = JSON.parse(text);
        if (code !== pair.claim.code) return json({}, 409);
        pair.approved = true;
      } else return json({}, 409);
      await this.ctx.storage.put('pair', pair);
      return json({ claim: pair.claim, approved: pair.approved || false });
    } catch { return json({ error: 'Invalid or expired pairing request.' }, 400); }
  }
}

export async function relayRequest(request: Request, env: RelayEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/pairings' && request.method === 'POST') {
    // Browser calls are same-origin; native requests have no Origin header. No CORS or cookies.
    if (request.headers.get('Origin') !== url.origin) return json({}, 403);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limit = await env.PAIRINGS.getByName('rate:' + await hash(ip)).fetch('https://relay/rate');
    if (!limit.ok) return json({ error: 'Too many pairing requests. Try again later.' }, 429);
    const id = crypto.randomUUID();
    const response = await env.PAIRINGS.getByName(id).fetch(new Request('https://relay/create', request));
    if (!response.ok) return response;
    return json({ id, ...await response.json() as object });
  }
  const match = /^\/pairings\/([0-9a-f-]{36})(?:\/(claim|approve))?$/.exec(url.pathname);
  if (!match || !['POST', 'GET'].includes(request.method) || (request.method === 'GET' && match[2])) return json({}, 404);
  if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return json({}, 403);
  return env.PAIRINGS.getByName(match[1]).fetch(request);
}
