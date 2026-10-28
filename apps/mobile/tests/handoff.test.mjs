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
  request.startedAt -= 120_001;
  assert.throws(() => parseSessionLink(link(sealed, request.state), request));
});
