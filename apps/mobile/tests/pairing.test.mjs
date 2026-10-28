import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64urlnopad } from '@scure/base';
import { generateDeviceKey } from '../src/api/device.ts';
import { PAIR_HKDF_INFO, claimRoom, formatCode, pairPhone, pollRoom, unsealPairing } from '../src/api/pairing.ts';

const encoder = new TextEncoder();
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const ORIGIN = 'https://district.example';
const ROOM = 'room_' + 'R'.repeat(20);
const SECRET = 's'.repeat(43);
const link = { origin: ORIGIN, room: ROOM, secret: SECRET };
const device = { label: "Ava's iPhone", platform: 'ios', model: 'iPhone 16', appVersion: '0.1.0' };
const credential = { deviceId: 'dev_' + 'd'.repeat(22), accessToken: 'dat1.claims.mac', refreshToken: 'opaque-refresh', principalId: 'p-ava' };

/** What the district does on approval, with WebCrypto: ECDH P-256 → HKDF-SHA-256 → AES-256-GCM. */
async function seal(phoneJwk, room, plaintext) {
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const phone = await crypto.subtle.importKey('jwk', { ...phoneJwk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: phone }, ephemeral.privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(room), info: encoder.encode(PAIR_HKDF_INFO) },
    hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = random(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(plaintext))));
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  return { epk: { kty, crv, x, y }, iv: base64urlnopad.encode(iv), ct: base64urlnopad.encode(ct) };
}

test('the district-sealed credential opens with the phone key (WebCrypto seal, noble unseal)', async () => {
  const key = generateDeviceKey(random);
  const sealed = await seal(key.publicJwk, ROOM, { ...credential, accessTokenExpiresAt: '2026-10-28T12:15:00.000Z' });
  assert.deepEqual(unsealPairing(sealed, key.privateKey, ROOM), { ...credential, accessTokenExpiresAt: '2026-10-28T12:15:00.000Z' });
});

test('another key, another room, tampering or a malformed credential cannot be opened', async () => {
  const key = generateDeviceKey(random);
  const sealed = await seal(key.publicJwk, ROOM, credential);
  assert.throws(() => unsealPairing(sealed, generateDeviceKey(random).privateKey, ROOM), (e) => e.code === 'invalid');
  assert.throws(() => unsealPairing(sealed, key.privateKey, ROOM + 'x'), (e) => e.code === 'invalid');
  const ct = base64urlnopad.decode(sealed.ct); ct[3] ^= 1;
  assert.throws(() => unsealPairing({ ...sealed, ct: base64urlnopad.encode(ct) }, key.privateKey, ROOM), (e) => e.code === 'invalid');
  assert.throws(() => unsealPairing({ ...sealed, epk: { ...sealed.epk, crv: 'P-384' } }, key.privateKey, ROOM), (e) => e.code === 'invalid');
  assert.throws(() => unsealPairing(undefined, key.privateKey, ROOM), (e) => e.code === 'invalid');
  for (const bad of [{ ...credential, deviceId: 'not-a-device' }, { ...credential, principalId: undefined }, { ...credential, accessToken: 7 }]) {
    const s = await seal(key.publicJwk, ROOM, bad);
    assert.throws(() => unsealPairing(s, key.privateKey, ROOM), (e) => e.code === 'invalid' && !/JSON|deviceId/.test(e.message));
  }
});

test('claim and poll follow the relay contract exactly', async (t) => {
  const key = generateDeviceKey(random);
  const fetch = t.mock.fn(async (_url, init) => {
    if (init.method === 'POST') return Response.json({ code: 'k7q4m2xd' });
    return Response.json({ state: 'waiting' });
  });
  assert.equal(await claimRoom(fetch, link, key.publicJwk, { ...device, label: 'x'.repeat(200) }), 'K7Q4M2XD');
  const [claimUrl, claim] = fetch.mock.calls[0].arguments;
  assert.equal(claimUrl, ORIGIN + '/api/pair/rooms/' + ROOM + '/claim');
  assert.equal(claim.redirect, 'manual');
  assert.equal(claim.headers['content-type'], 'application/json');
  const body = JSON.parse(claim.body);
  assert.deepEqual(Object.keys(body).sort(), ['device', 'publicJwk', 'secret']);
  assert.equal(body.secret, SECRET);
  assert.deepEqual(body.publicJwk, key.publicJwk);
  assert.equal(body.device.label.length, 80, 'bounded to what the district accepts');
  assert.deepEqual(await pollRoom(fetch, link), { state: 'waiting' });
  assert.equal(fetch.mock.calls[1].arguments[0], ORIGIN + '/api/pair/rooms/' + ROOM + '?secret=' + SECRET);
  assert.equal(fetch.mock.calls[1].arguments[1].method, 'GET');
  assert.equal(formatCode('K7Q4M2XD'), 'K7Q4·M2XD');
});

test('pairing claims, shows the code, waits for approval and returns the opened credential', async () => {
  const key = generateDeviceKey(random);
  const sealed = await seal(key.publicJwk, ROOM, credential);
  const states = ['waiting', 'waiting', 'approved'];
  const codes = [];
  const fetch = async (url, init) => init.method === 'POST' ? Response.json({ code: 'ABCD1234' })
    : Response.json(states[0] === 'approved' ? { state: states.shift(), sealed } : { state: states.shift() });
  const result = await pairPhone({ link, privateKey: key.privateKey, publicJwk: key.publicJwk, device, fetch,
    onCode: (c) => codes.push(c), signal: new AbortController().signal, intervalMs: 1 });
  assert.deepEqual(codes, ['ABCD1234']);
  assert.deepEqual(result, credential);
});

test('denied, expired, used, cancelled and Access-redirected rooms fail with readable messages', async () => {
  const key = generateDeviceKey(random);
  const run = (fetch, signal = new AbortController().signal) => pairPhone({ link, privateKey: key.privateKey,
    publicJwk: key.publicJwk, device, fetch, onCode: () => {}, signal, intervalMs: 1 });
  const claimed = (poll) => async (url, init) => init.method === 'POST' ? Response.json({ code: 'ABCD1234' }) : poll();
  await assert.rejects(run(claimed(() => Response.json({ state: 'denied' }))), (e) => e.code === 'denied');
  await assert.rejects(run(claimed(() => Response.json({ state: 'expired' }))), (e) => e.code === 'expired');
  await assert.rejects(run(async () => new Response(null, { status: 410 })), (e) => e.code === 'expired');
  await assert.rejects(run(async () => Response.json({ code: 'conflict' }, { status: 409 })), (e) => e.code === 'used');
  await assert.rejects(run(async () => new Response(null, { status: 302, headers: { location: 'https://x.cloudflareaccess.com/' } })),
    (e) => e.code === 'unavailable' && !/302|redirect/i.test(e.message));
  await assert.rejects(run(async () => { throw new TypeError('Network request failed'); }), (e) => e.code === 'unreachable' && !/Network request/.test(e.message));
  await assert.rejects(run(async () => Response.json({ code: 'not 8 chars' })), (e) => e.code === 'invalid');
  await assert.rejects(run(claimed(() => Response.json({ state: 'approved' }))), (e) => e.code === 'invalid');
  const controller = new AbortController();
  const pending = run(claimed(() => Response.json({ state: 'waiting' })), controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (e) => e.code === 'cancelled');
});
