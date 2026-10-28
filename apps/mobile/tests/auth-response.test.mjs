import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authResponseUrl } from '../src/auth/response.ts';

test('validated universal link wins when browser reports cancellation or dismissal', async () => {
  for (const type of ['cancel', 'dismiss']) {
    assert.equal(await authResponseUrl({ type }, Promise.resolve('validated-callback')), 'validated-callback');
    assert.equal(await authResponseUrl({ type }, new Promise(resolve => setTimeout(() => resolve('late-callback'), 5)), 100), 'late-callback');
  }
});
test('closing browser without a callback ends sign-in', async () => {
  await assert.rejects(authResponseUrl({ type: 'cancel' }, new Promise(() => {}), 5), /closed before returning/);
});
test('successful browser callback is preserved', async () => {
  assert.equal(await authResponseUrl({ type: 'success', url: 'browser-callback' }, new Promise(() => {})), 'browser-callback');
});
