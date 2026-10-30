import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptCallback, hash, makeClaim, schoolDetails, token, type Pairing } from './pairing.ts';
const id = 'b5cd3cd4-e8c5-4c44-a7c0-a24d8554278b';
async function claim() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
  return makeClaim(id, { state: `pair-v1.${id}.${'a'.repeat(43)}`, publicKey });
}
const school = { name: 'Harbor', portal: 'https://harbor.educateos.io', workshop: 'https://schoolos.gmac.io' };
const callback = (state: string) => new URL('https://mobile.educateos.io/oauthredirect?' + new URLSearchParams({ state, cfos_callback: 'install-connected', publicKey: 'a'.repeat(87), salt: 'b'.repeat(43), iv: 'c'.repeat(16), ciphertext: 'd'.repeat(200) }));
test('school origins cannot inject a path, userinfo, port or non-HTTPS scheme', () => {
  assert.deepEqual(schoolDetails(school), school);
  for (const portal of ['https://evil.test/path', 'https://user@evil.test', 'http://school.test', 'https://school.test:444', 'https://school.test/?x=1']) assert.throws(() => schoolDetails({ ...school, portal }));
});
test('claim binds comparison code to one phone key and pairing state', async () => {
  const first = await claim(), second = await claim();
  assert.match(first.code, /^[0-9A-F]{8}$/);
  assert.notEqual(first.code, second.code);
  assert.equal(first.code, (await hash(first.state + '.' + first.publicKey)).slice(0, 8).toUpperCase());
  await assert.rejects(makeClaim(id, { ...first, state: 'unrelated-state' }));
  await assert.rejects(makeClaim(id, { ...first, publicKey: 'a'.repeat(87) }));
});
test('transfer requires browser approval, exact claim, expiry and single delivery', async () => {
  const phone = await claim();
  const pair: Pairing = { school, browserHash: await hash(token()), phoneHash: await hash(token()), expiresAt: 1000, claim: phone };
  assert.throws(() => acceptCallback(pair, callback(phone.state), 1));
  pair.approved = true;
  assert.throws(() => acceptCallback(pair, callback(phone.state + 'other'), 1));
  assert.throws(() => acceptCallback(pair, callback(phone.state), 1000));
  const duplicate = callback(phone.state); duplicate.searchParams.append('state', phone.state);
  assert.throws(() => acceptCallback(pair, duplicate, 1));
  acceptCallback(pair, callback(phone.state), 1);
  assert.equal(pair.callback, callback(phone.state).href);
  assert.throws(() => acceptCallback(pair, callback(phone.state), 2));
});
