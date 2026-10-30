import { test } from 'node:test';
import assert from 'node:assert/strict';
import { p256 } from '@noble/curves/nist.js';
import { base64urlnopad } from '@scure/base';
import { sealDeviceSessionHandoff } from '../../../packages/workshop-backend/src/auth/device-session-handoff.ts';
import { parseSessionLink, unseal } from '../src/auth/crypto.ts';

// Workers provide these TC39 codecs; Node 24 does not yet ship them.
if (!Uint8Array.fromBase64) {
  Uint8Array.fromBase64 = (value, options) => new Uint8Array(Buffer.from(value,
    options?.alphabet === 'base64url' ? 'base64url' : 'base64'));
  // eslint-disable-next-line no-extend-native -- Emulate the Workers codec for the real backend in Node 24.
  Uint8Array.prototype.toBase64 = function(options) {
    return Buffer.from(this).toString(options?.alphabet === 'base64url' ? 'base64url' : 'base64');
  };
}

function attempt() {
  const privateKey = p256.utils.randomSecretKey();
  return { privateKey, publicKey: base64urlnopad.encode(p256.getPublicKey(privateKey, false)),
    state: base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(32))), startedAt: Date.now() };
}
const credential = () => ({ kind: 'workshop', token: 'installation:secret', expiresAt: Date.now() + 86_400_000 });
function link(envelope, state) {
  return 'https://mobile.educateos.io/oauthredirect?' + new URLSearchParams({
    cfos_callback: 'install-connected', state, ...envelope,
  });
}

test('native decrypts the real backend WebCrypto envelope and wipes its private key', async () => {
  const request = attempt();
  const expected = credential();
  const sealed = await sealDeviceSessionHandoff(request.publicKey, request.state, expected);
  assert.deepEqual(unseal(parseSessionLink(link(sealed, request.state), request), request), expected);
  assert.ok(request.privateKey.every(b => b === 0));
});

test('a sign-in the person takes a while to finish still decrypts', async () => {
  // The district seals the transfer when the browser sign-in finishes, with its own two-minute
  // deadline; a real sign-in takes longer than a few seconds after the app opened the browser.
  for (const elapsed of [6_000, 60_000, 5 * 60_000]) {
    const request = attempt();
    request.startedAt -= elapsed;
    const expected = credential();
    const sealed = await sealDeviceSessionHandoff(request.publicKey, request.state, expected);
    assert.deepEqual(unseal(parseSessionLink(link(sealed, request.state), request), request), expected, elapsed + ' ms');
  }
});

test('a transfer claiming to outlive the two-minute handoff is refused', async () => {
  const request = attempt();
  const sealed = await sealDeviceSessionHandoff(request.publicKey, request.state, credential(), Date.now() + 10 * 60_000);
  assert.throws(() => unseal(sealed, request), /could not be verified/);
});

test('state substitution, tampering and expired transfers cannot authenticate', async () => {
  for (const mode of ['state', 'ciphertext', 'expired']) {
    const request = attempt();
    const sealed = await sealDeviceSessionHandoff(request.publicKey, request.state, credential(),
      mode === 'expired' ? Date.now() - 1 : Date.now() + 120_000);
    if (mode === 'state') request.state = 'different-state-0123456789';
    if (mode === 'ciphertext') {
      const bytes = base64urlnopad.decode(sealed.ciphertext); bytes[0] ^= 1;
      sealed.ciphertext = base64urlnopad.encode(bytes);
    }
    assert.throws(() => unseal(sealed, request), /could not be verified/);
    assert.ok(request.privateKey.every(b => b === 0));
  }
});

test('callback rejects another attempt, duplicate state, and expired attempt', async () => {
  const request = attempt();
  const sealed = await sealDeviceSessionHandoff(request.publicKey, request.state, credential());
  assert.throws(() => parseSessionLink(link(sealed, 'other-state-0123456789'), request));
  assert.throws(() => parseSessionLink(link(sealed, request.state) + '&state=' + request.state, request));
  request.startedAt -= 15 * 60_000 + 1;
  assert.throws(() => parseSessionLink(link(sealed, request.state), request));
});
