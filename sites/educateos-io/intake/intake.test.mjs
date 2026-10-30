import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {CONSENT_VERSION, HOLD_MS, RETENTION_MS, configured, handleIntake, hmac} from './core.mjs';
import {IntakeStore} from './store.mjs';

// A transactional fake of Cloudflare's storage and service boundary, not an in-memory production
// fallback. Recreating the DO adapter against this backing storage exercises persistence.
import {FakeStorage} from "./fake-cloudflare.mjs";

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
function valid(overrides = {}) {
  return {name: 'Alex Example', workEmail: 'alex@example.invalid', org: 'Fictional school', state: 'MI',
    role: 'District IT', interestType: 'feedback', marketingOptIn: false, responseConsent: true,
    staffConfirmed: true, privacyAcknowledged: true, limitedFeedback: 'A simpler planning workflow would help',
    referralSource: 'teachers', consentVersion: CONSENT_VERSION, honeypot: '',
    turnstileToken: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), ...overrides};
}
function setup() {
  const storage = new FakeStorage();
  let store = new IntakeStore(storage), now = NOW, verifies = 0, calls = 0;
  const env = {
    INTEREST_ENABLED: 'true', INTEREST_OPTOUT_ENABLED: 'true', INTEREST_REVIEWED: CONSENT_VERSION,
    INTEREST_TURNSTILE_SITE_KEY: '0xfixtureSiteKeyNotARealKey', INTEREST_TURNSTILE_SECRET: '0xfixtureSecretNotARealKey',
    INTEREST_HMAC_SECRET: 'h'.repeat(40), INTEREST_EXPORT_TOKEN: 'e'.repeat(40), INTEREST_PRIVACY_TOKEN: 'p'.repeat(40),
    INTEREST: {idFromName(name) { assert.equal(name, 'foundation-interest-v1'); return name; },
      get() { return {fetch(url, init) { calls++; return store.fetch(new Request(url, init)); }}; }},
  };
  const deps = {now: () => now, fetch: async (url, init) => {
    verifies++;
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body.get('secret'), env.INTEREST_TURNSTILE_SECRET);
    return Response.json({success: true, hostname: 'educateos.io', action: 'interest', challenge_ts: new Date(now).toISOString()});
  }};
  const request = (body = valid(), {path = '/api/interest', method = 'POST', headers = {}, origin = 'https://educateos.io'} = {}) => new Request(origin + path, {
    method, headers: {'content-type': 'application/json', origin: 'https://educateos.io', 'sec-fetch-site': 'same-origin',
      'x-interest-request': '1', 'CF-Connecting-IP': '192.0.2.1', ...headers}, ...(method === 'GET' ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)}),
  });
  const run = (body, options) => handleIntake(request(body, options), env, deps);
  const exported = async (cursor = '') => {
    const response = await run(null, {path: '/api/interest/admin/export' + (cursor ? '?cursor=' + cursor : ''), method: 'GET', headers: {authorization: 'Bearer ' + env.INTEREST_EXPORT_TOKEN}});
    return {response, body: await response.json()};
  };
  return {env, deps, storage, request, run, exported, get calls() {return calls;}, get verifies() {return verifies;},
    advance(ms) {now += ms;}, restart() { store = new IntakeStore(storage); }, purge: () => store.purge(now)};
}
const records = s => [...s.storage.values].filter(([key]) => key.startsWith('record:'));

test('closed production defaults and every missing required binding/secret create no contacts or external calls', async () => {
  for (const field of ['INTEREST_ENABLED', 'INTEREST_REVIEWED', 'INTEREST_TURNSTILE_SITE_KEY', 'INTEREST_TURNSTILE_SECRET', 'INTEREST_HMAC_SECRET', 'INTEREST_EXPORT_TOKEN', 'INTEREST_PRIVACY_TOKEN', 'INTEREST']) {
    const s = setup(); delete s.env[field];
    assert.equal(configured(s.env), false);
    assert.equal((await s.run()).status, 503);
    assert.equal(s.verifies, 0); assert.equal(s.calls, 0); assert.equal(s.storage.values.size, 0);
  }
  for (const key of ['1x00000000000000000000AA', '2x00000000000000000000AB', '3x00000000000000000000FF']) {
    const s = setup(); s.env.INTEREST_TURNSTILE_SECRET = key;
    assert.equal((await s.run()).status, 503);
  }
  const s = setup(); s.env.INTEREST_PRIVACY_TOKEN = s.env.INTEREST_EXPORT_TOKEN;
  assert.equal((await s.run()).status, 503);
});

test('config exposes only public site key and consent version; existing routes pass through unchanged', async () => {
  const s = setup();
  const response = await s.run(null, {path: '/api/interest/config', method: 'GET'});
  assert.deepEqual(await response.json(), {siteKey: s.env.INTEREST_TURNSTILE_SITE_KEY, consentVersion: CONSENT_VERSION});
  for (const path of ['/', '/teachers/', '/app', '/healthz', '/clever/launch', '/api/interesting']) {
    assert.equal(await s.run(null, {path, method: 'GET'}), null);
  }
  assert.equal((await s.run(null, {origin: 'https://www.educateos.io'})).status, 404);
  assert.equal((await s.run(null, {method: 'GET'})).status, 405);
  assert.equal((await s.run(null, {method: 'OPTIONS'})).status, 405);
});

test('cross-origin, CSRF, opaque origins and simple browser submissions are rejected before verification', async () => {
  const s = setup();
  for (const headers of [{origin: 'https://evil.invalid'}, {origin: 'null'}, {origin: ''}, {'x-interest-request': ''}, {'sec-fetch-site': 'cross-site'}, {'content-type': 'text/plain'}, {'content-type': 'application/x-www-form-urlencoded'}]) {
    assert.equal((await s.run(valid(), {headers})).status, 400);
  }
  assert.equal(s.verifies, 0); assert.equal(records(s).length, 0);
});

test('bounded strict validation rejects spoofed status/role/org, XSS, URLs, private data, malformed JSON and consent inference', async () => {
  const cases = [
    {verificationStatus: 'verified'}, {role: 'Verified district CTO'}, {org: '<script>alert(1)</script>'},
    {org: 'https://127.0.0.1/admin'}, {name: '<img src=x onerror=alert(1)>'}, {limitedFeedback: 'See https://169.254.169.254/'},
    {limitedFeedback: 'Student Alex has a grade'}, {limitedFeedback: 'password abc'}, {limitedFeedback: '123-45-6789'},
    {limitedFeedback: 'Email child@example.invalid'}, {systems: 'javascript://attack'}, {limitedFeedback: 'x'.repeat(1001)},
    {workEmail: 'x\r\n@example.invalid'}, {name: 'x'.repeat(121)}, {org: 'x'.repeat(161)}, {state: 'CA'},
    {responseConsent: false}, {marketingOptIn: 'true'}, {staffConfirmed: false}, {privacyAcknowledged: false},
    {consentVersion: 'old'}, {turnstileToken: 'x'.repeat(2049)}, {idempotencyKey: 'guess'}, {referralSource: 'https://tracker.invalid'},
    {blocker: 'other'}, {councilType: 'chief'}, {systems: 'x'.repeat(121)},
  ];
  for (const input of cases) {
    const s = setup(); const response = await s.run(valid(input));
    assert.equal(response.status, 400, JSON.stringify(input));
    assert.equal(s.verifies, 0); assert.equal(records(s).length, 0);
    assert.ok(!(await response.text()).includes('Alex'));
  }
  for (const input of ['{', '[]', 'null', '"x"', 'x'.repeat(9000)]) {
    const s = setup(); assert.equal((await s.run(input)).status, 400); assert.equal(s.verifies, 0);
  }
});

test('Siteverify cannot be bypassed: wrong hostname/action, stale/future tokens, false success, HTTP failure and timeout fail closed', async () => {
  const cases = [
    {success: false}, {success: 'true'}, {hostname: 'evil.invalid'}, {hostname: 'educateos.io.evil.invalid'},
    {hostname: 'www.educateos.io'}, {action: ''}, {action: 'login'},
    {challenge_ts: new Date(NOW - 300001).toISOString()}, {challenge_ts: new Date(NOW + 30001).toISOString()}, {challenge_ts: 'invalid'},
  ];
  for (const override of cases) {
    const s = setup();
    s.deps.fetch = async () => Response.json({success: true, hostname: 'educateos.io', action: 'interest', challenge_ts: new Date(NOW).toISOString(), ...override});
    assert.equal((await s.run()).status, 400, JSON.stringify(override)); assert.equal(records(s).length, 0);
  }
  for (const fetcher of [async () => {throw new DOMException('timeout', 'TimeoutError');}, async () => new Response('private upstream failure', {status: 500}), async () => new Response('not json')]) {
    const s = setup(); s.deps.fetch = fetcher;
    const response = await s.run(); assert.equal(response.status, 400); assert.equal(records(s).length, 0);
    assert.ok(!(await response.text()).includes('upstream'));
  }
});

test('honeypot holds only a bounded aggregate and pretends success without verifying or retaining bot PII', async () => {
  const s = setup(); const response = await s.run(valid({honeypot: 'spam'}));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), {ok: true});
  assert.equal(s.verifies, 0); assert.equal(records(s).length, 0);
  assert.ok([...s.storage.values.keys()].some(k => k.startsWith('held:')));
  assert.ok(!JSON.stringify([...s.storage.values]).includes('alex@'));
  s.advance(HOLD_MS + 1); while (await s.purge()) {};
  assert.ok(![...s.storage.values.keys()].some(k => k.startsWith('held:')));
});

test('accepted feedback is unverified with independent consent and leaks no PII/tokens in responses or metadata', async () => {
  const s = setup(); const input = valid({councilType: 'technical', blocker: 'privacy', systems: 'Canvas'});
  const response = await s.run(input);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), {ok: true});
  assert.match(response.headers.get('cache-control'), /no-store/); assert.equal(response.headers.get('access-control-allow-origin'), null);
  const {body, response: download} = await s.exported();
  assert.deepEqual(Object.keys(body).toSorted(), ['records', 'schemaVersion', 'source']);
  assert.equal(body.schemaVersion, 1); assert.equal(body.source, 'website-interest'); assert.equal(body.records.length, 1);
  const row = body.records[0];
  assert.equal(row.verificationStatus, 'unverified'); assert.equal(row.marketingOptIn, false); assert.equal(row.responseConsent, true);
  assert.equal(row.org, 'Fictional school'); assert.equal(row.role, 'District IT');
  assert.equal(row.receivedAt, new Date(NOW).toISOString()); assert.match(row.externalId, /^[\da-f-]{36}$/);
  assert.match(row.limitedFeedback, /Council: technical; Blocker: privacy; LMS\/SSO: Canvas/);
  assert.deepEqual(Object.keys(row).toSorted(), ['externalId','receivedAt','name','workEmail','org','state','role','interestType','marketingOptIn','verificationStatus','consentVersion','limitedFeedback','referralSource','responseConsent','staffConfirmed','privacyAcknowledged'].toSorted());
  const persisted = JSON.stringify([...s.storage.values]);
  for (const secret of [input.turnstileToken, input.idempotencyKey, '192.0.2.1', s.env.INTEREST_HMAC_SECRET, s.env.INTEREST_TURNSTILE_SECRET]) assert.ok(!persisted.includes(secret));
  assert.match(download.headers.get('content-disposition'), /attachment/);
});

test('idempotency survives DO recreation, races and fresh security challenges; changed duplicate is rejected', async () => {
  const s = setup(); const input = valid();
  const responses = await Promise.all([s.run(input), s.run(input)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]); assert.equal(records(s).length, 1);
  const first = (await s.exported()).body.records[0].externalId;
  s.restart();
  assert.equal((await s.run({...input, turnstileToken: 'fresh-challenge'})).status, 200);
  assert.equal((await s.run({...input, limitedFeedback: 'Changed', turnstileToken: 'another-fresh'})).status, 409);
  assert.equal(records(s).length, 1); assert.equal((await s.exported()).body.records[0].externalId, first);
});

test('Turnstile token single use holds across new requests, addresses and DO restarts', async () => {
  const s = setup(); const input = valid();
  assert.equal((await s.run(input)).status, 200); s.restart();
  assert.equal((await s.run(valid({turnstileToken: input.turnstileToken, workEmail: 'other@example.invalid'}))).status, 400);
  assert.equal(records(s).length, 1);
});

test('IP and email rate limits return 429 without contact duplication', async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) assert.equal((await s.run(valid({workEmail: `person${i}@example.invalid`}))).status, 200);
  const limited = await s.run(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '600');
  assert.equal(s.verifies, 10); s.advance(600001);
  assert.equal((await s.run(valid({workEmail: 'new@example.invalid'}))).status, 200);
  const e = setup();
  for (let i = 0; i < 3; i++) assert.equal((await e.run()).status, 200);
  assert.equal((await e.run()).status, 429);
});

test('export is read-only, bearer scoped and never unlocked by public headers or control-plane identities', async () => {
  const s = setup(); await s.run();
  for (const token of ['', 'Bearer wrong', 'Bearer ' + s.env.INTEREST_PRIVACY_TOKEN]) {
    const r = await s.run(null, {path: '/api/interest/admin/export', method: 'GET', headers: {authorization: token, 'Cf-Access-Authenticated-User-Email': 'admin@example.invalid'}});
    assert.equal(r.status, 401); assert.ok(!(await r.text()).includes('alex'));
  }
  const denied = await s.run({workEmail: 'alex@example.invalid', action: 'deletion', verified: true}, {path: '/api/interest/admin/privacy', headers: {authorization: 'Bearer ' + s.env.INTEREST_EXPORT_TOKEN}});
  assert.equal(denied.status, 401); assert.equal(records(s).length, 1);
});

test('email-only opt-out works without intake, Turnstile, staff declarations, extra PII or confirmation', async () => {
  const s = setup(); await s.run();
  delete s.env.INTEREST_TURNSTILE_SECRET; s.env.INTEREST_ENABLED = 'false';
  const result = await s.run('workEmail=alex%40example.invalid', {path: '/api/interest/unsubscribe', headers: {'content-type': 'application/x-www-form-urlencoded', 'x-interest-request': ''}});
  assert.equal(result.status, 200); assert.match(result.headers.get('content-type'), /text\/html/);
  assert.ok(!(await result.text()).includes('alex@'));
  assert.equal(s.verifies, 1);
  const tombstone = 'suppressed:' + await hmac(s.env.INTEREST_HMAC_SECRET, 'email:alex@example.invalid');
  assert.equal(await s.storage.get(tombstone), true);
  assert.ok(!tombstone.includes('alex'));
  // Restore intake/export configuration only; ordinary contacts stay hidden.
  s.env.INTEREST_TURNSTILE_SECRET = '0xfixtureSecretNotARealKey'; s.env.INTEREST_ENABLED = 'true';
  const exported = (await s.exported()).body.records;
  assert.equal(exported.length, 1); assert.equal(exported[0].interestType, 'unsubscribe');
  assert.equal(exported[0].staffConfirmed, false); assert.equal(exported[0].responseConsent, false); assert.equal(exported[0].name, '');
  assert.equal((await s.run({workEmail: 'alex@example.invalid'}, {path: '/api/interest/unsubscribe'})).status, 200);
  assert.equal((await s.exported()).body.records.length, 1);
});

test('unverified deletion requests suppress but cannot erase; verified operator erasure preserves suppression', async () => {
  const s = setup(); await s.run();
  assert.equal((await s.run(valid({interestType: 'deletion'}))).status, 200);
  assert.equal(records(s).length, 2); // no unverified erasure
  const headers = {authorization: 'Bearer ' + s.env.INTEREST_PRIVACY_TOKEN};
  const path = '/api/interest/admin/privacy';
  assert.equal((await s.run({workEmail: 'alex@example.invalid', action: 'deletion', verified: false}, {path, headers})).status, 400);
  assert.equal((await s.run({workEmail: 'alex@example.invalid', action: 'deletion', verified: true}, {path, headers})).status, 200);
  assert.equal(records(s).length, 0);
  assert.ok(!JSON.stringify([...s.storage.values]).includes('alex@'));
  s.restart(); assert.equal((await s.run()).status, 200); assert.equal(records(s).length, 0);
  assert.deepEqual((await s.exported()).body.records, []);
});

test('retention excludes expired data from export before alarms, then purges records and metadata but retains tombstones', async () => {
  const s = setup(); await s.run();
  await s.run({workEmail: 'stop@example.invalid'}, {path: '/api/interest/unsubscribe'});
  s.advance(RETENTION_MS + 1);
  assert.deepEqual((await s.exported()).body.records, []);
  while (await s.purge()) {};
  assert.equal(records(s).length, 0);
  assert.ok([...s.storage.values.keys()].every(k => k.startsWith('suppressed:')));
});

test('unconfigured opt-out fails closed, CSRF fails, extra fields fail, service failures never echo private errors', async () => {
  const s = setup(); const path = '/api/interest/unsubscribe';
  s.env.INTEREST_OPTOUT_ENABLED = 'false'; assert.equal((await s.run({workEmail: 'alex@example.invalid'}, {path})).status, 503);
  s.env.INTEREST_OPTOUT_ENABLED = 'true';
  assert.equal((await s.run({workEmail: 'alex@example.invalid'}, {path, headers: {origin: 'https://evil.invalid'}})).status, 400);
  assert.equal((await s.run({workEmail: 'alex@example.invalid', name: 'unneeded'}, {path})).status, 400);
  s.env.INTEREST.get = () => ({fetch() {throw new Error('private database failure alex@example.invalid');}});
  const failed = await s.run(); assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes('alex'));
});

test('landing forms expose labels, separate unchecked consents and no advertising scripts; no sensitive logging', async () => {
  for (const page of ['interest', 'advisory', 'feedback']) {
    const html = await readFile(new URL(`../public/${page}/index.html`, import.meta.url), 'utf8');
    for (const field of ['name', 'workEmail', 'org', 'state', 'role', 'outcome', 'blocker', 'systems', 'limitedFeedback']) {
      assert.ok(html.includes(`for="${field}"`)); assert.ok(html.includes(`id="${field}"`));
    }
    assert.match(html, /role="alert" tabindex="-1"/); assert.match(html, /name="marketingOptIn">/);
    assert.match(html, /name="responseConsent" required/); assert.match(html, /form id="interest-form"[^>]* hidden/);
    assert.match(html, /exploring a foundation model/);
    assert.ok(!/google-analytics|facebook\.net|gtag\(/.test(html));
  }
  for (const file of ['core.mjs', 'store.mjs', 'worker.ts']) {
    assert.ok(!/console\.|logger\./.test(await readFile(new URL(file, import.meta.url), 'utf8')));
  }
});
