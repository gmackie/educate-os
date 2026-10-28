import { test } from 'node:test';
import assert from 'node:assert/strict';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad } from '@scure/base';
import { DeviceSession, createProof, generateDeviceKey, publicJwkOf, tokenHash } from '../src/api/device.ts';
import { DistrictClient } from '../src/api/client.ts';

const ORIGIN = 'https://district.example';
const encoder = new TextEncoder();
const decode = (part) => JSON.parse(new TextDecoder().decode(base64urlnopad.decode(part)));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

function memoryVault(initial) {
  let value = initial ? structuredClone(initial) : null;
  return {
    saves: 0, clears: 0,
    async load() { return value ? structuredClone(value) : null; },
    async save(next) { this.saves++; value = structuredClone(next); },
    async clear() { this.clears++; value = null; },
    peek() { return value; },
  };
}

function storedDevice(key, overrides = {}) {
  return {
    v: 1, deviceId: 'dev_' + 'a'.repeat(20), principalId: 'p-student', privateKey: base64urlnopad.encode(key.privateKey),
    accessToken: 'dat1.access-1', accessTokenExpiresAt: Date.now() + 10 * 60_000,
    refreshToken: 'refresh-1', refreshTokenExpiresAt: Date.now() + 86_400_000, ...overrides,
  };
}

/** Verifies a Device-Proof the way the district does (WebCrypto ECDSA P-256, raw r||s). */
async function verifyProof(jwk, proof) {
  const [h, p, s] = proof.split('.');
  const key = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, base64urlnopad.decode(s), encoder.encode(h + '.' + p));
  return { ok, header: decode(h), claims: decode(p), signature: base64urlnopad.decode(s) };
}

const json = (body, init = {}) => Response.json(body, init);
const refusal = (reason) => json({ code: 'unauthenticated', reason, message: 'refused' },
  { status: 401, headers: { 'www-authenticate': `Device error="${reason}"` } });
let ids = 0;
const session = (vault, fetch, extra = {}) => new DeviceSession(ORIGIN, vault, { fetch, randomId: () => 'jti-' + String(++ids).padStart(16, '0'), ...extra });

test('a device key is a valid P-256 key with an RFC 7517 public JWK', () => {
  const key = generateDeviceKey(random);
  assert.equal(key.privateKey.length, 32);
  assert.deepEqual(Object.keys(key.publicJwk).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal(base64urlnopad.decode(key.publicJwk.x).length, 32);
  assert.deepEqual(publicJwkOf(key.privateKey), key.publicJwk);
  // Out-of-range candidates are rejected: zero first, then a valid scalar.
  let calls = 0;
  const sampled = generateDeviceKey((n) => (calls++ === 0 ? new Uint8Array(n) : random(n)));
  assert.equal(calls, 2);
  assert.equal(sampled.privateKey.length, 32);
});

test('the proof is a compact ES256 JWS over method, path, time, token hash and a fresh jti', async () => {
  const key = generateDeviceKey(random);
  const proof = createProof(key.privateKey, { htm: 'GET', htu: '/api/m/me', token: 'dat1.x.y', iat: 1_800_000_000, jti: 'b'.repeat(16) });
  const { ok, header, claims, signature } = await verifyProof(key.publicJwk, proof);
  assert.ok(ok, 'WebCrypto (the district) verifies the signature');
  assert.equal(signature.length, 64, 'raw r||s, not DER');
  assert.deepEqual(header, { alg: 'ES256', typ: 'device-proof+jwt' });
  assert.deepEqual(claims, { htm: 'GET', htu: '/api/m/me', iat: 1_800_000_000, ath: tokenHash('dat1.x.y'), jti: 'b'.repeat(16) });
  assert.equal(claims.ath, base64urlnopad.encode(sha256(encoder.encode('dat1.x.y'))));
  // noble agrees, and a changed payload fails.
  const [h, p, s] = proof.split('.');
  assert.ok(p256.verify(base64urlnopad.decode(s), encoder.encode(h + '.' + p), p256.getPublicKey(key.privateKey)));
  assert.equal(p256.verify(base64urlnopad.decode(s), encoder.encode(h + '.' + p + 'x'), p256.getPublicKey(key.privateKey)), false);
});

test('requests go to /api/m with the device token and a proof for that exact request', async (t) => {
  const key = generateDeviceKey(random);
  const vault = memoryVault(storedDevice(key));
  const fetch = t.mock.fn(async () => json({ principalId: 'p-student' }));
  const client = new DistrictClient(ORIGIN, { kind: 'device', deviceId: 'dev_x', principalId: 'p' }, session(vault, fetch));
  assert.ok(client.available);
  await client.calendar(new Date(0), new Date(1000));
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(new URL(url).pathname, '/api/m/me/calendar');
  assert.equal(new URL(url).searchParams.get('from'), new Date(0).toISOString());
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.authorization, 'Device dat1.access-1');
  const { ok, claims } = await verifyProof(key.publicJwk, init.headers['device-proof']);
  assert.ok(ok);
  assert.equal(claims.htm, 'GET');
  assert.equal(claims.htu, '/api/m/me/calendar', 'path without the query');
  assert.equal(claims.ath, tokenHash('dat1.access-1'));
  assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
});

test('token-expired refreshes once for concurrent requests, then each retries with a new proof', async () => {
  const key = generateDeviceKey(random);
  const vault = memoryVault(storedDevice(key));
  const seen = { refresh: 0, jtis: new Set(), requests: [] };
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const proof = await verifyProof(key.publicJwk, init.headers['device-proof']);
    assert.ok(proof.ok);
    assert.ok(!seen.jtis.has(proof.claims.jti), 'every proof has a fresh jti');
    seen.jtis.add(proof.claims.jti);
    if (pathname === '/api/m/token/refresh') {
      seen.refresh++;
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { refreshToken: 'refresh-1' });
      assert.equal(proof.claims.ath, tokenHash('refresh-1'), 'the refresh proof hashes the refresh token');
      assert.equal(proof.claims.htu, '/api/m/token/refresh');
      await new Promise((r) => setTimeout(r, 10));
      return json({ deviceId: 'dev_' + 'a'.repeat(20), accessToken: 'dat1.access-2', refreshToken: 'refresh-2',
        accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    }
    seen.requests.push(init.headers.authorization);
    return init.headers.authorization === 'Device dat1.access-1' ? refusal('token-expired') : json({ ok: pathname });
  };
  const device = session(vault, fetch);
  const results = await Promise.all([device.request('GET', '/api/me'), device.request('GET', '/api/me/notifications'), device.request('GET', '/api/student/offerings')]);
  assert.deepEqual(results.map((r) => r.ok), ['/api/m/me', '/api/m/me/notifications', '/api/m/student/offerings']);
  assert.equal(seen.refresh, 1, 'one refresh: a second would present a used refresh token and revoke the phone');
  assert.equal(vault.peek().accessToken, 'dat1.access-2');
  assert.equal(vault.peek().refreshToken, 'refresh-2', 'both tokens replaced together');
  // A request that failed with the old token after the refresh finished reuses the new tokens.
  await device.refresh('dat1.access-1');
  assert.equal(seen.refresh, 1);
});

test('an access token about to expire is refreshed before the request', async () => {
  const key = generateDeviceKey(random);
  const vault = memoryVault(storedDevice(key, { accessTokenExpiresAt: Date.now() + 5_000 }));
  const paths = [];
  const fetch = async (url, init) => {
    paths.push(new URL(url).pathname);
    if (paths.at(-1) === '/api/m/token/refresh') return json({ deviceId: 'dev_' + 'a'.repeat(20), accessToken: 'dat1.fresh', refreshToken: 'refresh-2' });
    assert.equal(init.headers.authorization, 'Device dat1.fresh');
    return json({});
  };
  await session(vault, fetch).request('GET', '/api/me');
  assert.deepEqual(paths, ['/api/m/token/refresh', '/api/m/me']);
  assert.ok(vault.peek().accessTokenExpiresAt > Date.now() + 10 * 60_000, 'missing expiries default to the protocol lifetime');
});

for (const [where, reason] of [['request', 'device-revoked'], ['refresh', 'refresh-token-reused'], ['refresh', 'device-revoked']]) {
  test(`${reason} on ${where} forgets the key and tokens and reports the phone signed out by the school`, async () => {
    const key = generateDeviceKey(random);
    const vault = memoryVault(storedDevice(key));
    let revoked = 0;
    const fetch = async (url) => {
      const refresh = new URL(url).pathname === '/api/m/token/refresh';
      if (where === 'request') return refusal(reason);
      return refresh ? refusal(reason) : refusal('token-expired');
    };
    const device = session(vault, fetch, { onRevoked: () => revoked++ });
    await assert.rejects(device.request('GET', '/api/me'), (e) => e.code === 'device-revoked' && e.status === 401 &&
      e.message === 'This phone was signed out by your school.');
    assert.equal(revoked, 1);
    assert.equal(vault.peek(), null, 'tokens and key are gone');
    await assert.rejects(device.request('GET', '/api/me'), (e) => e.code === 'needs-pairing');
  });
}

test('an expired or invalid refresh token means pairing again, without the revoked screen', async () => {
  for (const reason of ['invalid-refresh-token', 'refresh-token-expired']) {
    const key = generateDeviceKey(random);
    const vault = memoryVault(storedDevice(key));
    let revoked = 0;
    const fetch = async (url) => new URL(url).pathname === '/api/m/token/refresh' ? refusal(reason) : refusal('token-expired');
    await assert.rejects(session(vault, fetch, { onRevoked: () => revoked++ }).request('GET', '/api/me'), (e) => e.code === 'needs-pairing');
    assert.equal(revoked, 0);
    assert.equal(vault.peek(), null);
  }
});

test('a client or clock problem refreshes once and retries; if that still fails, sign in again', async () => {
  const key = generateDeviceKey(random);
  const vault = memoryVault(storedDevice(key));
  const calls = [];
  const fetch = async (url) => {
    calls.push(new URL(url).pathname);
    if (calls.at(-1) === '/api/m/token/refresh') return json({ deviceId: 'dev_' + 'a'.repeat(20), accessToken: 'dat1.next', refreshToken: 'refresh-next' });
    return refusal('invalid-proof');
  };
  await assert.rejects(session(vault, fetch).request('GET', '/api/me'), (e) => e.code === 'needs-pairing');
  assert.deepEqual(calls, ['/api/m/me', '/api/m/token/refresh', '/api/m/me']);
});

test('any redirect is needs-sign-in, never followed, and raw errors never reach the UI', async () => {
  const key = generateDeviceKey(random);
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' } }),
    () => new Response(null, { status: 307 }),
    // What React Native's fetch hands back for redirect: 'manual'.
    () => Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaqueredirect' }),
  ]) {
    const vault = memoryVault(storedDevice(key));
    await assert.rejects(session(vault, async () => response()).request('GET', '/api/me'),
      (e) => e.code === 'needs-sign-in' && e.status === 401 && !/redirect|fetch|302/i.test(e.message));
    assert.ok(vault.peek(), 'a redirect does not forget the credential');
  }
  const vault = memoryVault(storedDevice(key));
  await assert.rejects(session(vault, async () => { throw new TypeError("Redirect is not allowed when redirect mode is 'error'"); }).request('GET', '/api/me'),
    (e) => e.code === 'unreachable' && !/redirect mode/.test(e.message));
  await assert.rejects(session(vault, async () => new Response('<html>stack trace</html>', { status: 500 })).request('GET', '/api/me'),
    (e) => e.status === 500 && !/stack/.test(e.message));
  await assert.rejects(session(vault, async () => json({ code: 'unavailable', reason: 'device-auth-unavailable' }, { status: 503 })).request('GET', '/api/me'),
    (e) => e.status === 503 && /hasn't turned on phone sign-in/.test(e.message));
  await assert.rejects(session(vault, async () => json({ code: 'forbidden', message: 'Not your class.' }, { status: 403 })).request('GET', '/api/me'),
    (e) => e.status === 403 && e.code === 'forbidden' && e.message === 'Not your class.');
});

test('device sessions only call /api paths on their own origin', async () => {
  const key = generateDeviceKey(random);
  const device = session(memoryVault(storedDevice(key)), async () => json({}));
  await assert.rejects(device.request('GET', '/api/m/me'), /Invalid district API path/);
  await assert.rejects(device.request('GET', '/admin'), /Invalid district API path/);
  await assert.rejects(device.request('GET', '/api/me/../../x'), /Invalid district API path/);
});

test('a device client without a paired device asks to pair, and push registration tolerates a 404', async () => {
  const none = new DistrictClient(ORIGIN, { kind: 'device', deviceId: 'dev_x', principalId: 'p' });
  assert.equal(none.available, false);
  await assert.rejects(none.me(), (e) => e.code === 'needs-pairing');
  const key = generateDeviceKey(random);
  let body;
  const client = new DistrictClient(ORIGIN, { kind: 'device', deviceId: 'dev_x', principalId: 'p' },
    session(memoryVault(storedDevice(key)), async (url, init) => { body = JSON.parse(init.body); return json({ code: 'not-found' }, { status: 404 }); }));
  assert.equal(await client.registerPushToken('ExponentPushToken[abc]', 'ios'), 'unsupported');
  assert.deepEqual(body, { token: 'ExponentPushToken[abc]', provider: 'expo', platform: 'ios' });
});
