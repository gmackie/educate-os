import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64urlnopad } from '@scure/base';
import { generateDeviceKey } from '../src/api/device.ts';
import {
  PAIR_HKDF_INFO, claimRoom, connectPhoneUrl, createSelfRoom, formatCode, jwkThumbprint, pairPhone, pairingCode, pollRoom,
  unsealPairing, waitForApproval,
} from '../src/api/pairing.ts';
import { isOwnRoomReturn, rememberOwnRoom } from '../src/links.ts';

const encoder = new TextEncoder();
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const ORIGIN = 'https://district.example';
const ROOM = 'room_' + 'R'.repeat(20);
const SECRET = 's'.repeat(43);
const link = { origin: ORIGIN, room: ROOM, secret: SECRET };
const device = { label: "Ava's iPhone", platform: 'ios', model: 'iPhone 16', appVersion: '0.1.0' };
const credential = { deviceId: 'dev_' + 'd'.repeat(22), accessToken: 'dat1.claims.mac', refreshToken: 'opaque-refresh', principalId: 'p-ava' };

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** The district's derivations (packages/educateos-district-app/src/pairing.ts), with WebCrypto. */
async function districtThumbprint(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical))));
}
async function districtCode(room, thumbprint) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(room + thumbprint)));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(digest.subarray(0, 8), (b) => alphabet[b % 36]).join('');
}

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

test('the code and thumbprint are derived exactly as the district derives them', async () => {
  for (let i = 0; i < 20; i++) {
    const key = generateDeviceKey(random);
    const room = b64url(random(16));
    const thumbprint = jwkThumbprint(key.publicJwk);
    assert.equal(thumbprint, await districtThumbprint(key.publicJwk));
    assert.match(thumbprint, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(pairingCode(room, thumbprint), await districtCode(room, thumbprint));
    assert.match(pairingCode(room, thumbprint), /^[A-Z0-9]{8}$/);
  }
  // A fixed vector, so a change to either side's derivation shows up here.
  assert.equal(pairingCode('room_' + 'R'.repeat(20), 'T'.repeat(43)), await districtCode('room_' + 'R'.repeat(20), 'T'.repeat(43)));
});

test('claim and poll follow the relay contract exactly', async (t) => {
  const key = generateDeviceKey(random);
  const expected = await districtCode(ROOM, await districtThumbprint(key.publicJwk));
  const fetch = t.mock.fn(async (_url, init) => {
    if (init.method === 'POST') return Response.json({ code: expected.toLowerCase() });
    return Response.json({ state: 'waiting' });
  });
  assert.equal(await claimRoom(fetch, link, key.publicJwk, { ...device, label: 'x'.repeat(200) }), expected);
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

test('a claim answered with a code for another key is refused', async () => {
  const key = generateDeviceKey(random);
  const other = generateDeviceKey(random);
  const wrong = pairingCode(ROOM, jwkThumbprint(other.publicJwk));
  await assert.rejects(claimRoom(async () => Response.json({ code: wrong }), link, key.publicJwk, device), (e) => e.code === 'invalid');
});

test('sign in on this phone: a self-room, the connect page, then polling (never a claim)', async (t) => {
  const key = generateDeviceKey(random);
  const room = b64url(random(16)), secret = b64url(random(32));
  const thumbprint = await districtThumbprint(key.publicJwk);
  const code = await districtCode(room, thumbprint);
  const sealed = await seal(key.publicJwk, room, { ...credential, accessExpiresAt: '2026-10-28T12:15:00.000Z', refreshExpiresAt: '2026-11-27T12:00:00.000Z' });
  const states = ['waiting', 'approved'];
  const fetch = t.mock.fn(async (url, init) => {
    if (init.method === 'POST') return Response.json({ room, secret, code, expiresAt: '2026-10-28T12:02:00.000Z' }, { status: 201 });
    const state = states.shift();
    return Response.json(state === 'approved' ? { state, sealed } : { state });
  });
  const self = await createSelfRoom(fetch, ORIGIN, key.publicJwk, { ...device, model: 'm'.repeat(200) });
  const [createUrl, create] = fetch.mock.calls[0].arguments;
  assert.equal(createUrl, ORIGIN + '/api/pair/self-rooms');
  assert.equal(create.method, 'POST');
  assert.equal(create.redirect, 'manual');
  const body = JSON.parse(create.body);
  assert.deepEqual(Object.keys(body).sort(), ['device', 'publicJwk']);
  assert.deepEqual(body.publicJwk, key.publicJwk);
  assert.equal(body.device.model.length, 80);
  assert.deepEqual(self, { link: { origin: ORIGIN, room, secret }, code, thumbprint });

  const page = new URL(connectPhoneUrl(self, 'google'));
  assert.equal(page.origin + page.pathname, ORIGIN + '/connect-phone');
  assert.deepEqual(Object.fromEntries(page.searchParams), { method: 'google', r: room, s: secret, k: thumbprint });

  const result = await waitForApproval({ link: self.link, privateKey: key.privateKey, fetch, signal: new AbortController().signal, intervalMs: 1 });
  assert.deepEqual(result, { ...credential, accessTokenExpiresAt: '2026-10-28T12:15:00.000Z', refreshTokenExpiresAt: '2026-11-27T12:00:00.000Z' });
  const polls = fetch.mock.calls.slice(1).map((c) => c.arguments);
  assert.equal(polls.length, 2);
  for (const [url, init] of polls) {
    assert.equal(url, ORIGIN + '/api/pair/rooms/' + room + '?secret=' + secret);
    assert.equal(init.method, 'GET');
  }
  assert.ok(!fetch.mock.calls.some((c) => String(c.arguments[0]).endsWith('/claim')));
});

test('self-room failures: a busy school, a malformed room and a code for another key', async () => {
  const key = generateDeviceKey(random);
  const create = (response) => createSelfRoom(async () => response, ORIGIN, key.publicJwk, device);
  await assert.rejects(create(Response.json({ code: 'unavailable', reason: 'too-many-rooms' }, { status: 429 })), (e) => e.code === 'busy');
  await assert.rejects(create(Response.json({ code: 'unavailable' }, { status: 503 })), (e) => e.code === 'unavailable');
  await assert.rejects(create(Response.json({ room: 'short', secret: 's'.repeat(43) }, { status: 201 })), (e) => e.code === 'invalid');
  await assert.rejects(create(Response.json({ room: ROOM, secret: 'x y' }, { status: 201 })), (e) => e.code === 'invalid');
  const wrong = pairingCode(ROOM, jwkThumbprint(generateDeviceKey(random).publicJwk));
  await assert.rejects(create(Response.json({ room: ROOM, secret: SECRET, code: wrong }, { status: 201 })), (e) => e.code === 'invalid');
});

test("the connect page's return to this phone's own self-room is not a new code", () => {
  const room = b64url(random(16));
  const join = { kind: 'join', join: { origin: ORIGIN, room, secret: SECRET } };
  assert.equal(isOwnRoomReturn(join), false);
  rememberOwnRoom(room);
  assert.equal(isOwnRoomReturn(join), true);
  assert.equal(isOwnRoomReturn({ kind: 'join', join: { origin: ORIGIN, room: room + 'x', secret: SECRET } }), false);
  assert.equal(isOwnRoomReturn({ kind: 'invalid', message: 'x' }), false);
});

test('pairing claims, shows the code, waits for approval and returns the opened credential', async () => {
  const key = generateDeviceKey(random);
  const sealed = await seal(key.publicJwk, ROOM, credential);
  const states = ['waiting', 'waiting', 'approved'];
  const codes = [];
  const code = pairingCode(ROOM, jwkThumbprint(key.publicJwk));
  const fetch = async (url, init) => init.method === 'POST' ? Response.json({ code })
    : Response.json(states[0] === 'approved' ? { state: states.shift(), sealed } : { state: states.shift() });
  const result = await pairPhone({ link, privateKey: key.privateKey, publicJwk: key.publicJwk, device, fetch,
    onCode: (c) => codes.push(c), signal: new AbortController().signal, intervalMs: 1 });
  assert.deepEqual(codes, [code]);
  assert.deepEqual(result, credential);
});

test('denied, expired, used, cancelled and Access-redirected rooms fail with readable messages', async () => {
  const key = generateDeviceKey(random);
  const run = (fetch, signal = new AbortController().signal) => pairPhone({ link, privateKey: key.privateKey,
    publicJwk: key.publicJwk, device, fetch, onCode: () => {}, signal, intervalMs: 1 });
  const code = pairingCode(ROOM, jwkThumbprint(key.publicJwk));
  const claimed = (poll) => async (url, init) => init.method === 'POST' ? Response.json({ code }) : poll();
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
