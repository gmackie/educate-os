import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {FakeStorage} from './fake-cloudflare.mjs';
import {CONSENT_VERSION} from './core.mjs';

// Load the real site wrapper and real DO adapter in a fake Workers runtime. Only the unrelated
// control-plane service and runtime base class are replaced; routing/intake/storage code is real.
const moduleUrl = code => 'data:text/javascript,' + encodeURIComponent(code);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return {shortCircuit: true, url: moduleUrl('export class DurableObject {constructor(ctx, env) {this.ctx=ctx; this.env=env;}}')};
    if (specifier.endsWith('educateos-control-plane/src/worker.ts')) return {shortCircuit: true, url: moduleUrl(`export class ControlPlane {};
      export const siteWorker = shell => ({fetch(request, env) {env.fallbackCalls.push(new URL(request.url).pathname);return new Response(shell.header + shell.footer);}});`)};
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.html')) return {shortCircuit: true, format: 'module', source: 'export default ' + JSON.stringify(readFileSync(new URL(url), 'utf8'))};
    return next(url, context);
  },
});
const {default: site, InterestIntake} = await import('../worker.ts');
class FakeContext {
  storage = new FakeStorage();
  constructor() {
    let alarm = null;
    this.storage.getAlarm = async () => alarm;
    this.storage.setAlarm = async time => {alarm = time;};
  }
}

test('real site wrapper leaves existing paths with existing control-plane handler and assets shell', async () => {
  const env = {fallbackCalls: []};
  for (const path of ['/', '/app', '/healthz', '/registry/heartbeat', '/clever/launch', '/teachers/']) {
    const response = await site.fetch(new Request('https://educateos.io' + path), env, {});
    assert.equal(response.status, 200); assert.match(await response.text(), /EducateOS/);
  }
  assert.deepEqual(env.fallbackCalls, ['/', '/app', '/healthz', '/registry/heartbeat', '/clever/launch', '/teachers/']);
  const closed = await site.fetch(new Request('https://educateos.io/api/interest'), env, {});
  assert.equal(closed.status, 503); assert.equal(env.fallbackCalls.length, 6);
});

test('real isolated DO binding accepts only intake traffic and schedules retention before persisting', async () => {
  const ctx = new FakeContext();
  const env = {fallbackCalls: [], INTEREST_ENABLED: 'true', INTEREST_OPTOUT_ENABLED: 'true', INTEREST_REVIEWED: CONSENT_VERSION,
    INTEREST_HMAC_SECRET: 'h'.repeat(40), INTEREST_EXPORT_TOKEN: 'e'.repeat(40), INTEREST_PRIVACY_TOKEN: 'p'.repeat(40),
    INTEREST_TURNSTILE_SITE_KEY: '0xfixtureSiteKeyNotARealKey', INTEREST_TURNSTILE_SECRET: '0xfixtureSecretNotARealKey',
    CONTROL_PLANE: {get() {throw new Error('district/control-plane namespace must never be touched');}},
  };
  const object = new InterestIntake(ctx, env);
  let bindingCalls = 0;
  env.INTEREST = {
    idFromName(name) {assert.equal(name, 'foundation-interest-v1'); return name;},
    get() {bindingCalls++; return {fetch: (url, init) => object.fetch(new Request(url, init))};},
  };
  const response = await site.fetch(new Request('https://educateos.io/api/interest/unsubscribe', {method: 'POST',
    headers: {origin: 'https://educateos.io', 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.1'}, body: JSON.stringify({workEmail: 'fictional@example.invalid'})}), env, {});
  assert.equal(response.status, 200); assert.ok(bindingCalls >= 2); assert.equal(env.fallbackCalls.length, 0);
  assert.ok(await ctx.storage.getAlarm() > Date.now());
  const exported = await site.fetch(new Request('https://educateos.io/api/interest/admin/export', {headers: {authorization: 'Bearer ' + env.INTEREST_EXPORT_TOKEN}}), env, {});
  assert.equal(exported.status, 200); assert.equal((await exported.json()).records[0].interestType, 'unsubscribe');
  await object.alarm(); assert.ok(await ctx.storage.getAlarm() > Date.now());
});

test('retention alarm failures abort intake instead of accepting records without cleanup', async () => {
  const ctx = new FakeContext(); ctx.storage.setAlarm = async () => {throw new Error('alarm unavailable');};
  const object = new InterestIntake(ctx, {});
  await assert.rejects(object.fetch(new Request('https://intake.internal/unsubscribe', {method: 'POST', body: JSON.stringify({now: Date.now(), address: 'hashed', workEmail: 'fake@example.invalid'})})), /alarm unavailable/);
  assert.equal(ctx.storage.values.size, 0);
});
