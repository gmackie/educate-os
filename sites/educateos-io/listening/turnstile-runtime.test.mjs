import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const {Miniflare, convertV4MiniflareOptions} = createRequire(require.resolve('wrangler'))('miniflare');

test('Siteverify reaches the provider in workerd and rejects redirects without following them', async () => {
  const source = readFileSync(new URL('../intake/core.mjs', import.meta.url), 'utf8');
  let providerCalls = 0, redirect = false;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'listening-siteverify-runtime', compatibilityDate: '2026-10-01',
    compatibilityFlags: ['global_fetch_strictly_public'],
    modules: [{type: 'ESModule', path: 'entry.mjs', contents: `import {verifyTurnstile} from './core.mjs';\nexport default {async fetch() {
      return Response.json({verified: await verifyTurnstile({INTEREST_TURNSTILE_SECRET: 'synthetic-secret'},
        'synthetic-challenge', '192.0.2.1', Date.now(), fetch, 'listening')});
    }};`}, {type: 'ESModule', path: 'core.mjs', contents: source}],
    outboundService: async request => {
      providerCalls++;
      assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(request.method, 'POST');
      assert.equal((await request.formData()).get('response'), 'synthetic-challenge');
      if (redirect) return new Response(null, {status: 302, headers: {location: 'https://never-follow.invalid/'}});
      return Response.json({success: true, hostname: 'educateos.io', action: 'listening', challenge_ts: new Date().toISOString()});
    },
  }));
  try {
    assert.equal((await (await mf.dispatchFetch('https://fixture.invalid')).json()).verified, true);
    assert.equal(providerCalls, 1);
    redirect = true;
    assert.equal((await (await mf.dispatchFetch('https://fixture.invalid')).json()).verified, false);
    assert.equal(providerCalls, 2, 'redirect must not issue another outbound request');
  } finally { await mf.dispose(); }
});
