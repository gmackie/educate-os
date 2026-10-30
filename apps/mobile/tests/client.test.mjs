import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DistrictClient } from '../src/api/client.ts';

test('password sessions never reach the district API', async t => {
  const fetch = t.mock.method(globalThis, 'fetch');
  const client = new DistrictClient('https://district.example', {
    kind: 'workshop', token: 'private', expiresAt: Date.now() + 1000,
  });
  await assert.rejects(client.me(), e => e.status === 403 && e.code === 'needs-access');
  assert.equal(fetch.mock.callCount(), 0);
});

test('district requests authenticate at both the Access edge and Worker without following redirects', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ principalId: 'student' }));
  const client = new DistrictClient('https://district.example', { kind: 'cloudflare-access', token: 'test.jwt.value' });
  assert.deepEqual(await client.me(), { principalId: 'student' });
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://district.example/api/me');
  assert.equal(options.headers.cookie, 'CF_Authorization=test.jwt.value');
  assert.equal(options.headers['cf-access-jwt-assertion'], 'test.jwt.value');
  assert.equal(options.redirect, 'manual');
});

test('district authorization refusals remain failures', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'forbidden', message: 'Access revoked' }, { status: 403 }));
  const client = new DistrictClient('https://district.example', { kind: 'cloudflare-access', token: 'test.jwt.value' });
  await assert.rejects(client.me(), e => e.status === 403 && e.code === 'forbidden' && e.message === 'Access revoked');
});

test('an Access login redirect is reported as needing sign-in, not as a fetch failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/district.example' },
  }));
  const client = new DistrictClient('https://district.example', { kind: 'cloudflare-access', token: 'test.jwt.value' });
  await assert.rejects(client.me(), e => e.status === 401 && e.code === 'needs-sign-in' &&
    !/redirect|fetch/i.test(e.message));
});

test('native fetch errors never reach the user verbatim', async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error("Redirect is not allowed when redirect mode is 'error'");
  });
  const client = new DistrictClient('https://district.example', { kind: 'cloudflare-access', token: 'test.jwt.value' });
  await assert.rejects(client.me(), e => e.code === 'unreachable' && !/redirect mode/.test(e.message));
});
