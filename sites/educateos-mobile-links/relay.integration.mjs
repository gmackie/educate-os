import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sealDeviceSessionHandoff } from '../../packages/workshop-backend/src/auth/device-session-handoff.ts';
if (!Uint8Array.fromBase64) {
  Uint8Array.fromBase64 = (value, options) => new Uint8Array(Buffer.from(value, options?.alphabet === 'base64url' ? 'base64url' : 'base64'));
  // eslint-disable-next-line no-extend-native -- Match the Workers codec for the real backend encryptor in Node.
  Uint8Array.prototype.toBase64 = function(options) { return Buffer.from(this).toString(options?.alphabet === 'base64url' ? 'base64url' : 'base64'); };
}
const origin = process.env.RELAY_TEST_ORIGIN || 'http://localhost:8999';
const transport = (url, options = {}) => {
  if (!process.env.RELAY_TEST_RESOLVE) return fetch(url, options);
  const args = ['--silent', '--show-error', '--max-time', '20', '--resolve', `mobile.educateos.io:443:${process.env.RELAY_TEST_RESOLVE}`, '-w', '\n%{http_code}', url];
  for (const [key, value] of Object.entries(options.headers || {})) args.push('-H', `${key}: ${value}`);
  if (options.method) args.push('-X', options.method);
  if (options.body) args.push('--data-binary', options.body);
  const raw = execFileSync('curl', args, { encoding: 'utf8' });
  const end = raw.lastIndexOf('\n');
  return Promise.resolve({ status: Number(raw.slice(end + 1)), json: () => Promise.resolve(JSON.parse(raw.slice(0, end))) });
};
const school = { name: 'Harbor Charter', portal: 'https://harbor.educateos.io', workshop: 'https://schoolos.gmac.io' };
async function api(path, token, body, expected = 200, source = origin) {
  const response = await transport(origin + path, { method: body ? 'POST' : 'GET', headers: {
    Origin: source, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  assert.equal(response.status, expected);
  return response.status === 200 ? response.json() : null;
}
await api('/pairings', null, school, 403, 'https://evil.example');
const room = await api('/pairings', null, school);
const path = '/pairings/' + room.id;
await api(path, 'bad', undefined, 403);
await api(path + '/approve', room.browserToken, { code: '00000000' }, 409);
const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const pub = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
const secret = new Uint8Array(Buffer.from((await crypto.subtle.exportKey('jwk', keys.privateKey)).d, 'base64url'));
const attempt = { publicKey: pub, privateKey: secret, state: `pair-v1.${room.id}.${'a'.repeat(43)}`, startedAt: Date.now() };
await api(path + '/claim', room.browserToken, { state: attempt.state, publicKey: pub }, 409);
await api(path + '/claim', room.phoneToken, { state: attempt.state, publicKey: pub });
await api(path + '/claim', room.phoneToken, { state: attempt.state, publicKey: pub }, 409);
const pending = await api(path, room.browserToken);
assert.equal(pending.claim.state, attempt.state);
await api(path + '/approve', room.phoneToken, { code: pending.claim.code }, 409);
await api(path + '/approve', room.browserToken, { code: 'wrong' }, 409);
const credential = { kind: 'workshop', token: 'integration-only:credential', expiresAt: Date.now() + 86400000 };
const sealed = await sealDeviceSessionHandoff(pub, attempt.state, credential);
const callback = '/oauthredirect?' + new URLSearchParams({ state: attempt.state, cfos_callback: 'install-connected', ...sealed });
assert.equal((await transport(origin + callback)).status, 410);
await api(path + '/approve', room.browserToken, { code: pending.claim.code });
assert.equal((await transport(origin + callback)).status, 200);
assert.equal((await transport(origin + callback)).status, 410);
const delivered = await api(path, room.phoneToken);
const received = new URL(delivered.callback);
assert.equal(received.origin, 'https://mobile.educateos.io');
assert.equal(received.searchParams.get('state'), attempt.state);
for (const [key, value] of Object.entries(sealed)) assert.equal(received.searchParams.get(key), value);
assert.ok(!delivered.callback.includes(credential.token));
secret.fill(0);
await api(path, room.phoneToken, undefined, 410);
// The App Link metadata: Android's statement (from the worker) and Apple's (a static asset).
const assetlinks = await transport(origin + '/.well-known/assetlinks.json');
assert.equal(assetlinks.status, 200);
const [statement] = await assetlinks.json();
assert.equal(statement.target.package_name, 'io.educateos.mobile', 'the store app is listed first');
assert.ok(Array.isArray(statement.target.sha256_cert_fingerprints));
const aasa = await transport(origin + '/.well-known/apple-app-site-association');
assert.equal(aasa.status, 200);
assert.ok((await aasa.json()).applinks.details[0].components.some(c => c['/'] === '/j'));
for (const page of ['/', '/j', '/enroll', '/pair-phone']) assert.equal((await transport(origin + page)).status, 200, page);
console.log('PASS: origin isolation, role separation, key claim, browser consent, encrypted backend envelope delivery, replay rejection, single-use retrieval, app-link metadata and landing pages');
