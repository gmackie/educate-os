import {authorized, boundedJson, email, hmac, reply, verifyTurnstile} from '../intake/core.mjs';
import {NOTICE_VERSION, validateSubmission} from './schema.mjs';
/** Worker-first route owned by adult community listening. */
export const LISTENING_PATHS = ['/api/listening/*'];
const ORIGIN = 'https://educateos.io';
/** Close collection unless credentials, isolation and the notice review are configured. */
export function configured(env) {
  const secrets = ['LISTENING_HMAC_SECRET', 'LISTENING_EXPORT_TOKEN', 'LISTENING_PRIVACY_TOKEN'];
  return env.LISTENING_ENABLED === 'true' && env.LISTENING_REVIEWED === NOTICE_VERSION && !!env.INTEREST &&
    secrets.every(k => typeof env[k] === 'string' && env[k].length >= 32) &&
    new Set(secrets.map(k => env[k])).size === secrets.length &&
    /^0x[A-Za-z0-9_-]{10,100}$/.test(env.LISTENING_TURNSTILE_SITE_KEY ?? '') &&
    /^0x[A-Za-z0-9_-]{10,100}$/.test(env.LISTENING_TURNSTILE_SECRET ?? '');
}
/** Isolated, unauthenticated submissions and separately authenticated staff export/erasure. */
export async function handleListening(request, env, dependencies = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/listening/')) return null;
  if (url.origin !== ORIGIN) return reply(404);
  const now = dependencies.now?.() ?? Date.now();
  const call = async (kind, action, data) => {
    const stub = env.INTEREST.get(env.INTEREST.idFromName('community-listening-v1-' + kind));
    const response = await stub.fetch('https://intake.internal/' + action, {method: 'POST', body: JSON.stringify({now, ...data})});
    if (!response.ok) throw new Error('unavailable');
    return response.json();
  };
  try {
    // Operators retain export and erasure access when public collection is paused.
    const isAdmin = url.pathname.startsWith('/api/listening/admin/');
    if (isAdmin) {
      const challengeCheck = url.pathname === '/api/listening/admin/challenge-check';
      const erase = url.pathname === '/api/listening/admin/privacy' || challengeCheck;
      if (!await authorized(request, env[erase ? 'LISTENING_PRIVACY_TOKEN' : 'LISTENING_EXPORT_TOKEN'])) return reply(401);
      if (!env.INTEREST || typeof env.LISTENING_HMAC_SECRET !== 'string' || env.LISTENING_HMAC_SECRET.length < 32) return reply(503);
      if (challengeCheck) {
        if (request.method !== 'POST') return reply(405, {ok: false}, {Allow: 'POST'});
        const body = await boundedJson(request);
        if (Object.keys(body).length !== 1 || typeof body.turnstileToken !== 'string' ||
            !body.turnstileToken || body.turnstileToken.length > 2048) return reply(400);
        // Staff-only preflight, including while collection is paused. Never persist or echo
        // the challenge, secret, IP, provider response or request headers. No store dispatch.
        const provider = {responded: false, httpOk: false, success: false,
          hostnameMatches: false, actionMatches: false, timestampValid: false,
          secretRejected: false, responseRejected: false, expiredOrReused: false};
        const verified = await verifyTurnstile({INTEREST_TURNSTILE_SECRET: env.LISTENING_TURNSTILE_SECRET},
          body.turnstileToken, request.headers.get('CF-Connecting-IP') ?? '', now, async (target, init) => {
            const response = await (dependencies.fetch ?? fetch)(target, init);
            provider.responded = true; provider.httpOk = response.ok;
            const result = await response.clone().json();
            provider.success = result.success === true;
            const codes = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
            provider.secretRejected = codes.includes('invalid-input-secret') || codes.includes('missing-input-secret');
            provider.responseRejected = codes.includes('invalid-input-response') || codes.includes('missing-input-response');
            provider.expiredOrReused = codes.includes('timeout-or-duplicate');
            provider.hostnameMatches = result.hostname === 'educateos.io';
            provider.actionMatches = result.action === 'listening';
            const age = now - Date.parse(result.challenge_ts);
            provider.timestampValid = age >= -30000 && age <= 300000;
            return response;
          }, 'listening');
        return reply(200, {verified, provider});
      }
      if (url.pathname === '/api/listening/admin/export') {
        if (request.method !== 'GET') return reply(405, {ok: false}, {Allow: 'GET'});
        const kind = url.searchParams.get('kind');
        const cursor = url.searchParams.get('cursor') ?? '';
        if (!['survey', 'contact'].includes(kind) || (cursor && !/^[0-9a-f-]{36}$/.test(cursor))) return reply(400);
        const result = await call(kind, 'export', {cursor});
        return reply(200, {schemaVersion: 1, source: 'community-listening', kind, records: result.records}, {
          'Content-Disposition': `attachment; filename="listening-${kind}.json"`, 'X-Next-Cursor': result.nextCursor,
        });
      }
      if (!erase) return reply(404);
      if (request.method !== 'POST') return reply(405, {ok: false}, {Allow: 'POST'});
      const body = await boundedJson(request);
      if (Object.keys(body).some(k => !['kind', 'receipt', 'email', 'verified'].includes(k)) || body.verified !== true ||
          !['survey', 'contact'].includes(body.kind)) return reply(400);
      const identity = body.kind === 'survey' ? body.receipt : email(body.email);
      if (body.kind === 'survey' && !/^[a-f0-9]{64}$/.test(identity)) return reply(400);
      const address = await hmac(env.LISTENING_HMAC_SECRET, body.kind + ':' + identity);
      await call(body.kind, 'privacy', {address, erase: true});
      return reply(200);
    }
    if (!configured(env)) return reply(503, {ok: false});
    if (url.pathname === '/api/listening/config' && request.method === 'GET') return reply(200, {
      siteKey: env.LISTENING_TURNSTILE_SITE_KEY, noticeVersion: NOTICE_VERSION,
    });
    const kind = url.pathname.slice('/api/listening/'.length);
    if (!['survey', 'contact'].includes(kind)) return reply(404);
    if (request.method !== 'POST') return reply(405, {ok: false}, {Allow: 'POST'});
    if (request.headers.get('origin') !== ORIGIN || request.headers.get('x-listening-request') !== '1' ||
        (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return reply(400);
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip || ip.length > 64) return reply(503);
    const ipHash = await hmac(env.LISTENING_HMAC_SECRET, 'ip:' + ip);
    if (!await call(kind, 'attempt', {ipHash})) return reply(429, {ok: false}, {'Retry-After': '600'});
    let input, record;
    try {
      input = await boundedJson(request);
      record = validateSubmission(input, kind);
      if (kind === 'contact') record.email = email(input.email);
    } catch { return reply(400); }
    if (input.honeypot) { await call(kind, 'hold', {}); return reply(200); }
    if (!await verifyTurnstile({INTEREST_TURNSTILE_SECRET: env.LISTENING_TURNSTILE_SECRET}, input.turnstileToken, ip, now, dependencies.fetch ?? fetch, 'listening')) return reply(400);
    const identity = kind === 'survey' ? input.receipt : record.email;
    const address = await hmac(env.LISTENING_HMAC_SECRET, kind + ':' + identity);
    const idem = await hmac(env.LISTENING_HMAC_SECRET, 'idem:' + kind + ':' + input.receipt);
    const fingerprint = await hmac(env.LISTENING_HMAC_SECRET, 'payload:' + JSON.stringify(record));
    const tokenHash = await hmac(env.LISTENING_HMAC_SECRET, 'challenge:' + input.turnstileToken);
    const result = await call(kind, 'submit', {record, address, idem, fingerprint, tokenHash});
    return reply(result.status, {ok: result.status === 200}, result.status === 429 ? {'Retry-After': '600'} : {});
  } catch { return reply(503); }
}
