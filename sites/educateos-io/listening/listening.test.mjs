import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {handleListening, configured} from './core.mjs';
import {NOTICE_VERSION, QUESTIONS, FOLLOW_UP} from './schema.mjs';
import {IntakeStore} from '../intake/store.mjs';
import {RETENTION_MS} from '../intake/core.mjs';
import {FakeStorage} from '../intake/fake-cloudflare.mjs';
const receipt = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
const valid = (kind = 'survey', overrides = {}) => ({adult: true, participation: true, noticeVersion: NOTICE_VERSION,
  receipt: receipt(), turnstileToken: crypto.randomUUID(), honeypot: '', ...(kind === 'survey' ?
    Object.fromEntries(Object.entries(QUESTIONS).map(([k, v]) => [k, [v[0]]])) :
    {email: 'adult@example.invalid', topic: FOLLOW_UP[0], followUpConsent: true}), ...overrides});
function setup() {
  let now = Date.now(), verifies = 0;
  const storages = new Map();
  const env = {LISTENING_ENABLED: 'true', LISTENING_REVIEWED: NOTICE_VERSION,
    LISTENING_HMAC_SECRET: 'h'.repeat(40), LISTENING_EXPORT_TOKEN: 'e'.repeat(40), LISTENING_PRIVACY_TOKEN: 'p'.repeat(40),
    LISTENING_TURNSTILE_SITE_KEY: '0xfixtureSiteKeyNotARealKey', LISTENING_TURNSTILE_SECRET: '0xfixtureSecretNotARealKey',
    INTEREST: {idFromName(name) {assert.match(name, /^community-listening-v1-(survey|contact)$/); return name;},
      get(name) {
        if (!storages.has(name)) storages.set(name, new FakeStorage());
        // Recreate adapter every call: persistence depends on durable storage, not object memory.
        return {fetch: (url, init) => new IntakeStore(storages.get(name)).fetch(new Request(url, init))};
      }},
  };
  const deps = {now: () => now, fetch: async (url, init) => {
    verifies++; assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal); assert.equal(init.body.get('remoteip'), '192.0.2.1');
    return Response.json({success: true, hostname: 'educateos.io', action: 'listening', challenge_ts: new Date(now).toISOString()});
  }};
  const run = (body = valid(), {path = '/api/listening/survey', method = 'POST', headers = {}, origin = 'https://educateos.io'} = {}) => handleListening(new Request(origin + path, {
    method, headers: {origin: 'https://educateos.io', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
      'x-listening-request': '1', 'CF-Connecting-IP': '192.0.2.1', ...headers},
    ...(method === 'GET' ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)}),
  }), env, deps);
  const exported = async (kind = 'survey', cursor = '') => {
    const response = await run(null, {path: '/api/listening/admin/export?kind=' + kind + '&cursor=' + cursor, method: 'GET', headers: {authorization: 'Bearer ' + env.LISTENING_EXPORT_TOKEN}});
    return {response, body: await response.json()};
  };
  return {env, deps, run, exported, storages, advance: ms => {now += ms;}, get verifies() {return verifies;},
    purge: async () => {for (const storage of storages.values()) while (await new IntakeStore(storage).purge(now)) { /* drain due entries */ }}};
}
test('fails closed without each configuration requirement and never calls a service', async () => {
  for (const key of Object.keys(setup().env)) {
    const s = setup(); delete s.env[key]; assert.equal(configured(s.env), false);
    assert.equal((await s.run()).status, 503); assert.equal(s.verifies, 0); assert.equal(s.storages.size, 0);
  }
  for (const key of ['1x00000000000000000000AA', '', 'bad']) {
    const s = setup(); s.env.LISTENING_TURNSTILE_SECRET = key; assert.equal((await s.run()).status, 503);
  }
  const s = setup(); s.env.LISTENING_PRIVACY_TOKEN = s.env.LISTENING_EXPORT_TOKEN; assert.equal((await s.run()).status, 503);
});
test('strict schemas enforce adults, consent, choice bounds, and separate contact purpose', async () => {
  const overrides = [{adult: false}, {adult: 'true'}, {participation: false}, {noticeVersion: 'old'}, {receipt: 'bad'},
    {email: 'student@example.invalid'}, {studentName: 'DO NOT STORE'}, {policy: [QUESTIONS.policy[0], QUESTIONS.policy[1]]},
    {roles: [QUESTIONS.roles[0], QUESTIONS.roles[0]]}, {tools: ['<script>']}, {workflows: 'free text'}, {turnstileToken: 'a'.repeat(2049)}];
  for (const override of overrides) {
    const s = setup(); assert.equal((await s.run(valid('survey', override))).status, 400); assert.equal(s.verifies, 0);
  }
  for (const override of [{followUpConsent: false}, {followUpConsent: 'true'}, {email: 'invalid'}, {topic: 'marketing'}, {roles: []}]) {
    const s = setup(); assert.equal((await s.run(valid('contact', override), {path: '/api/listening/contact'})).status, 400);
  }
  const s = setup(); assert.equal((await s.run(valid('survey', Object.fromEntries(Object.keys(QUESTIONS).map(k => [k, []]))))).status, 200);
});
test('bounded JSON and same-origin checks reject malformed, cross-site and simple submissions', async () => {
  for (const headers of [{origin: 'https://other.invalid'}, {origin: 'null'}, {'x-listening-request': ''}, {'sec-fetch-site': 'cross-site'}, {'content-type': 'text/plain'}]) {
    const s = setup(); assert.equal((await s.run(valid(), {headers})).status, 400); assert.equal(s.verifies, 0);
  }
  for (const raw of ['{', 'null', '[]', JSON.stringify({huge: 'x'.repeat(9000)})]) {
    const s = setup(); assert.equal((await s.run(raw)).status, 400); assert.equal(s.verifies, 0);
  }
});
test('valid survey persists across restarts, returns no data, and is isolated from optional contact', async () => {
  const s = setup(), input = valid();
  const response = await s.run(input); assert.equal(response.status, 200); assert.deepEqual(await response.json(), {ok: true});
  assert.match(response.headers.get('cache-control'), /no-store/); assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await s.run(valid('contact'), {path: '/api/listening/contact'})).status, 200);
  const surveys = await s.exported(), contacts = await s.exported('contact');
  assert.equal(surveys.body.records.length, 1); assert.equal(contacts.body.records.length, 1);
  assert.equal(contacts.body.records[0].followUpConsent, true); assert.equal(contacts.body.records[0].email, 'adult@example.invalid');
  assert.equal(surveys.body.records[0].email, undefined); assert.equal(contacts.body.records[0].tools, undefined);
  assert.notEqual(surveys.body.records[0].externalId, contacts.body.records[0].externalId);
  assert.match(surveys.response.headers.get('content-disposition'), /attachment/);
  const saved = JSON.stringify([...s.storages.values()].flatMap(v => [...v.values]));
  for (const secret of [input.receipt, input.turnstileToken, '192.0.2.1', s.env.LISTENING_HMAC_SECRET]) assert.ok(!saved.includes(secret));
});
test('idempotent retries, changed payload conflict and challenge replay are durable', async () => {
  const s = setup(), input = valid();
  assert.deepEqual((await Promise.all([s.run(input), s.run(input)])).map(r => r.status), [200, 200]);
  assert.equal((await s.exported()).body.records.length, 1);
  assert.equal((await s.run({...input, tools: [], turnstileToken: 'fresh'})).status, 409);
  assert.equal((await s.run({...input, receipt: receipt()})).status, 400);
});
test('security challenges reject wrong action/host, stale timestamps and provider failures', async () => {
  for (const override of [{action: 'interest'}, {hostname: 'evil.invalid'}, {success: false}, {challenge_ts: new Date(0).toISOString()}]) {
    const s = setup(); s.deps.fetch = async () => Response.json({success: true, hostname: 'educateos.io', action: 'listening', challenge_ts: new Date().toISOString(), ...override});
    assert.equal((await s.run()).status, 400);
  }
  const s = setup(); s.deps.fetch = async () => {throw new Error('secret upstream failure');}; assert.equal((await s.run()).status, 400);
});
test('limits attempts before external verification; honeypots store no payload', async () => {
  const s = setup(); for (let i = 0; i < 10; i++) assert.equal((await s.run(valid('survey', {adult: false}))).status, 400);
  const response = await s.run(); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '600'); assert.equal(s.verifies, 0);
  const bot = setup(); assert.equal((await bot.run(valid('contact', {honeypot: 'bot'}), {path: '/api/listening/contact'})).status, 200);
  assert.equal(bot.verifies, 0); assert.ok(!JSON.stringify([...bot.storages.values()].flatMap(v => [...v.values])).includes('adult@'));
});
test('exports and erasure require separate credentials, including when collection is paused', async () => {
  const s = setup(), input = valid(); await s.run(input); await s.run(valid('contact'), {path: '/api/listening/contact'});
  for (const authorization of ['', 'Bearer forged', 'Bearer ' + s.env.LISTENING_PRIVACY_TOKEN]) {
    assert.equal((await s.run(null, {method: 'GET', path: '/api/listening/admin/export?kind=survey', headers: {authorization, 'Cf-Access-Authenticated-User-Email': 'admin@example.invalid'}})).status, 401);
  }
  s.env.LISTENING_ENABLED = 'false'; assert.equal((await s.run()).status, 503);
  const erase = (body, token = s.env.LISTENING_PRIVACY_TOKEN) => s.run(body, {path: '/api/listening/admin/privacy', headers: {authorization: 'Bearer ' + token}});
  assert.equal((await erase({kind: 'survey', receipt: input.receipt, verified: true}, s.env.LISTENING_EXPORT_TOKEN)).status, 401);
  assert.equal((await erase({kind: 'survey', receipt: input.receipt, verified: false})).status, 400);
  assert.equal((await erase({kind: 'survey', receipt: input.receipt, verified: true})).status, 200);
  assert.equal((await s.exported()).body.records.length, 0); assert.equal((await s.exported('contact')).body.records.length, 1);
  assert.equal((await erase({kind: 'contact', email: 'adult@example.invalid', verified: true})).status, 200);
  assert.equal((await s.exported('contact')).body.records.length, 0);
  const state = [...s.storages.values()].flatMap(v => [...v.values]); assert.ok(!JSON.stringify(state).includes('adult@'));
});
test('expired records disappear from exports before cleanup and retention purges active data', async () => {
  const s = setup(); await s.run(); await s.run(valid('contact'), {path: '/api/listening/contact'});
  s.advance(RETENTION_MS + 1); assert.equal((await s.exported()).body.records.length, 0);
  assert.equal((await s.exported('contact')).body.records.length, 0); await s.purge();
  assert.equal([...s.storages.values()].flatMap(v => [...v.values.keys()]).length, 0);
});
test('pages have no analytics, keep closed defaults and expose only bounded controls', () => {
  const page = readFileSync(new URL('../public/have-your-say/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /dataflare.js|<textarea|name="email"|localStorage/);
  assert.match(page, /fieldset id="fields" disabled/); assert.match(page, /MagicSchool/); assert.match(page, /not registered as a nonprofit/);
  assert.match(page, /No AI use in education/); assert.match(page, /Existing tools meet my needs/);
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'); assert.match(headers, /\/have-your-say\/\*/);
});
