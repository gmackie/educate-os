/** Consent/notice revision required to open the otherwise closed intake. */
export const CONSENT_VERSION = 'website-interest-2026-10-30-v1';
/** Worker-first routes owned solely by intake. */
export const INTAKE_PATHS = ['/api/interest', '/api/interest/*'];
/** Contact record and idempotency retention: 90 days. */
export const RETENTION_MS = 90 * 86400000;
/** Non-PII bot hold aggregate retention: seven days. */
export const HOLD_MS = 7 * 86400000;
const ORIGIN = 'https://educateos.io';
const encoder = new TextEncoder();
const PRIVACY = new Set(['unsubscribe', 'deletion']);
const ROLES = ['Teacher/Curriculum', 'District IT', 'Head of School', 'Regional Partner', 'Developer'];
const INTERESTS = ['demo', 'council', 'technical-review', 'pilot', 'feedback', 'webinar', 'unsubscribe', 'deletion'];
const BLOCKERS = ['privacy', 'teacher workflow', 'cost', 'compatibility', 'IT support', 'assessment'];
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
/** Generic response with private caching and content isolation. */
export function reply(status, body = {ok: status === 200}, extra = {}) {
  return new Response(JSON.stringify(body), {status, headers: {...HEADERS, ...extra}});
}
/** Domain-separated keyed identifier; never persist plaintext IPs or challenges. */
export async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const supplied = request.headers.get('authorization') ?? '';
  if (supplied.length > 300) return false;
  const a = await hmac(secret, supplied);
  const b = await hmac(secret, `Bearer ${secret}`);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
/** Fail closed until independent secrets, bindings and review attestation are present. */
export function configured(env) {
  return env.INTEREST_ENABLED === 'true' && env.INTEREST_REVIEWED === CONSENT_VERSION &&
    /^0x[A-Za-z0-9_-]{10,100}$/.test(env.INTEREST_TURNSTILE_SITE_KEY ?? '') &&
    /^0x[A-Za-z0-9_-]{10,100}$/.test(env.INTEREST_TURNSTILE_SECRET ?? '') &&
    ['INTEREST_HMAC_SECRET', 'INTEREST_EXPORT_TOKEN', 'INTEREST_PRIVACY_TOKEN'].every(k => typeof env[k] === 'string' && env[k].length >= 32) &&
    new Set([env.INTEREST_HMAC_SECRET, env.INTEREST_EXPORT_TOKEN, env.INTEREST_PRIVACY_TOKEN]).size === 3 && !!env.INTEREST;
}
async function boundedJson(request) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) throw new Error('invalid');
  if (Number(request.headers.get('content-length')) > 8192) throw new Error('invalid');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid');
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 8192) { await reader.cancel(); throw new Error('invalid'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const result = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('invalid');
  return result;
}
// Plain text only. Reject rather than silently rewriting consent or unsafe content.
function text(value, max, optional = false) {
  if (typeof value !== 'string' || value.length > max) throw new Error('invalid');
  const clean = value.normalize('NFKC').trim();
  // Control characters are intentionally forbidden in all plain text.
  // oxlint-disable-next-line no-control-regex
  if ((!optional && !clean) || clean.length > max || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(clean) || /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b(?:[\w-]+\.)+(?:[a-z]{2,63})\b)/i.test(clean)) throw new Error('invalid');
  return clean;
}
function email(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)) throw new Error('invalid');
  return value.toLowerCase();
}
function choose(value, options) { if (!options.includes(value)) throw new Error('invalid'); return value; }
/** Validate explicit professional consent and plain bounded data; never trust identity claims. */
export function validate(input) {
  const fields = ['name', 'workEmail', 'org', 'state', 'role', 'interestType', 'marketingOptIn', 'responseConsent', 'staffConfirmed', 'privacyAcknowledged', 'limitedFeedback', 'referralSource', 'consentVersion', 'honeypot', 'turnstileToken', 'idempotencyKey', 'councilType', 'blocker', 'systems'];
  if (Object.keys(input).some(k => !fields.includes(k))) throw new Error('invalid');
  if (input.consentVersion !== CONSENT_VERSION || input.staffConfirmed !== true || input.privacyAcknowledged !== true || typeof input.marketingOptIn !== 'boolean' || typeof input.responseConsent !== 'boolean') throw new Error('invalid');
  const interestType = choose(input.interestType, INTERESTS);
  if (!PRIVACY.has(interestType) && input.responseConsent !== true) throw new Error('invalid');
  if (PRIVACY.has(interestType) && input.marketingOptIn) throw new Error('invalid');
  if (typeof input.idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)) throw new Error('invalid');
  if (typeof input.honeypot !== 'string' || input.honeypot.length > 200 || typeof input.turnstileToken !== 'string' || !input.turnstileToken || input.turnstileToken.length > 2048) throw new Error('invalid');
  const limitedFeedback = text(input.limitedFeedback ?? '', 1000, true);
  const systems = text(input.systems ?? '', 120, true);
  // A conservative deny-list is a backstop, not a DLP guarantee; review remains mandatory.
  if (/\b(student|pupil|learner|password|credential|secret|token|ssn)\b|\b\d{3}[- ]?\d{2}[- ]?\d{4}\b|[^\s]+@[^\s]+/i.test(limitedFeedback + ' ' + systems)) throw new Error('invalid');
  const council = input.councilType ? choose(input.councilType, ['educator', 'technical']) : '';
  const blocker = input.blocker ? choose(input.blocker, BLOCKERS) : '';
  const feedback = [council && `Council: ${council}`, blocker && `Blocker: ${blocker}`, systems && `LMS/SSO: ${systems}`, limitedFeedback].filter(Boolean).join('; ');
  return {
    name: text(input.name, 120), workEmail: email(input.workEmail), org: text(input.org, 160),
    state: choose(input.state, ['MI', 'TX', 'other']), role: choose(input.role, ROLES), interestType,
    marketingOptIn: input.marketingOptIn, verificationStatus: 'unverified', consentVersion: CONSENT_VERSION,
    limitedFeedback: feedback, referralSource: choose(input.referralSource, ['interest', 'advisory', 'feedback', 'demo', 'teachers', 'district']),
    responseConsent: input.responseConsent, staffConfirmed: true, privacyAcknowledged: true,
  };
}
/** Verify the fixed Siteverify endpoint, timestamp, exact hostname and action; fail closed. */
export async function verifyTurnstile(env, token, ip, now, send = fetch) {
  try {
    const response = await send('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({secret: env.INTEREST_TURNSTILE_SECRET, response: token, remoteip: ip}),
    });
    if (!response.ok) return false;
    const result = await response.json();
    const age = now - Date.parse(result.challenge_ts);
    return result.success === true && result.hostname === 'educateos.io' && result.action === 'interest' && age >= -30000 && age <= 300000;
  } catch { return false; }
}
/** Returns null for routes owned by the existing site/control plane. */
export async function handleIntake(request, env, dependencies = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/interest' && !url.pathname.startsWith('/api/interest/')) return null;
  if (url.origin !== ORIGIN) return reply(404);
  const now = dependencies.now?.() ?? Date.now();
  const call = async (action, data) => {
    const stub = env.INTEREST.get(env.INTEREST.idFromName('foundation-interest-v1'));
    const response = await stub.fetch('https://intake.internal/' + action, {method: 'POST', body: JSON.stringify({now, ...data})});
    if (!response.ok) throw new Error('unavailable');
    return response.json();
  };
  try {
    // Email-only opt-out has independent enablement and needs neither Turnstile nor marketing
    // intake credentials. Keep it available when the interest funnel is subsequently paused.
    if (url.pathname === '/api/interest/unsubscribe') {
      if (env.INTEREST_OPTOUT_ENABLED !== 'true' || env.INTEREST_REVIEWED !== CONSENT_VERSION ||
          !env.INTEREST || typeof env.INTEREST_HMAC_SECRET !== 'string' || env.INTEREST_HMAC_SECRET.length < 32) return reply(503);
      if (request.method !== 'POST') return reply(405, {ok: false}, {Allow: 'POST'});
      if (request.headers.get('origin') !== ORIGIN ||
          (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return reply(400);
      // Reuse the bounded reader for both a plain HTML form and JSON; never echo the address.
      let body;
      try {
        if (request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
          const reader = request.body?.getReader();
          if (!reader) return reply(400);
          let raw = '', bytes = 0;
          const decoder = new TextDecoder('utf-8', {fatal: true});
          try {
            for (;;) {
              const {value, done} = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 1024) { await reader.cancel(); return reply(400); }
              raw += decoder.decode(value, {stream: true});
            }
            raw += decoder.decode();
          } finally { reader.releaseLock(); }
          const fields = new URLSearchParams(raw);
          if (fields.size !== 1 || !fields.has('workEmail')) return reply(400);
          body = {workEmail: fields.get('workEmail')};
        } else body = await boundedJson(request);
        if (Object.keys(body).length !== 1) return reply(400);
        body.workEmail = email(body.workEmail);
      } catch { return reply(400); }
      const ip = request.headers.get('CF-Connecting-IP');
      if (!ip || ip.length > 64) return reply(503);
      const ipHash = await hmac(env.INTEREST_HMAC_SECRET, 'ip:' + ip);
      if (!await call('attempt', {ipHash, optout: true})) return reply(429, {ok: false}, {'Retry-After': '600'});
      const address = await hmac(env.INTEREST_HMAC_SECRET, 'email:' + body.workEmail);
      await call('unsubscribe', {address, workEmail: body.workEmail});
      if (request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
        return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opt-out received</title><main><h1>Opt-out received</h1><p>This address is suppressed from future updates in this intake. There is no need to confirm by email.</p><p><a href="/unsubscribe/">Return to opt-out page</a></p></main></html>', {headers: {...HEADERS, 'Content-Type': 'text/html; charset=utf-8'}});
      }
      return reply(200);
    }
    if (!configured(env)) return reply(503, {ok: false, message: 'Intake is currently closed.'});
    if (url.pathname === '/api/interest/config' && request.method === 'GET') return reply(200, {siteKey: env.INTEREST_TURNSTILE_SITE_KEY, consentVersion: CONSENT_VERSION});
    if (url.pathname === '/api/interest/admin/export' && request.method === 'GET') {
      if (!await authorized(request, env.INTEREST_EXPORT_TOKEN)) return reply(401);
      const cursor = url.searchParams.get('cursor') ?? '';
      if (cursor && !/^[0-9a-f-]{36}$/.test(cursor)) return reply(400);
      const result = await call('export', {cursor});
      return reply(200, {schemaVersion: 1, source: 'website-interest', records: result.records}, {
        'Content-Disposition': 'attachment; filename="website-interest.json"', 'X-Next-Cursor': result.nextCursor,
      });
    }
    if (url.pathname === '/api/interest/admin/privacy' && request.method === 'POST') {
      if (!await authorized(request, env.INTEREST_PRIVACY_TOKEN)) return reply(401);
      const body = await boundedJson(request);
      if (Object.keys(body).some(k => !['workEmail', 'action', 'verified'].includes(k)) || body.verified !== true || !PRIVACY.has(body.action)) return reply(400);
      const address = await hmac(env.INTEREST_HMAC_SECRET, 'email:' + email(body.workEmail));
      await call('privacy', {address, erase: body.action === 'deletion'});
      return reply(200);
    }
    if (url.pathname !== '/api/interest') return reply(404);
    if (request.method !== 'POST') return reply(405, {ok: false}, {Allow: 'POST'});
    if (request.headers.get('origin') !== ORIGIN || request.headers.get('x-interest-request') !== '1' ||
        (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return reply(400);
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip || ip.length > 64) return reply(503);
    const ipHash = await hmac(env.INTEREST_HMAC_SECRET, 'ip:' + ip);
    if (!await call('attempt', {ipHash})) return reply(429, {ok: false}, {'Retry-After': '600'});
    let input, record;
    try { input = await boundedJson(request); record = validate(input); } catch { return reply(400, {ok: false, message: 'Check the form. Use professional details only; omit links and sensitive information.'}); }
    if (input.honeypot) { await call('hold', {}); return reply(200); }
    if (!await verifyTurnstile(env, input.turnstileToken, ip, now, dependencies.fetch ?? fetch)) return reply(400, {ok: false, message: 'Complete a fresh security check and try again.'});
    const address = await hmac(env.INTEREST_HMAC_SECRET, 'email:' + record.workEmail);
    const idem = await hmac(env.INTEREST_HMAC_SECRET, 'idem:' + address + ':' + input.idempotencyKey);
    const fingerprint = await hmac(env.INTEREST_HMAC_SECRET, 'payload:' + JSON.stringify(record));
    const tokenHash = await hmac(env.INTEREST_HMAC_SECRET, 'challenge:' + input.turnstileToken);
    const result = await call('submit', {record, address, idem, fingerprint, tokenHash});
    return reply(result.status, result.status === 200 ? {ok: true} : {ok: false}, result.status === 429 ? {'Retry-After': '600'} : {});
  } catch { return reply(503, {ok: false, message: 'Intake is unavailable. Please try later.'}); }
}
