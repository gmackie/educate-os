import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strictOrigin, trustedUrl, appLink, uniqueParam } from '../src/security.ts';

test('school endpoints accept one canonical HTTPS origin', () => {
  assert.equal(strictOrigin('https://school.example'), 'https://school.example');
  assert.equal(strictOrigin('https://school.example/'), 'https://school.example');
  for (const value of ['javascript:alert(1)', 'http://school.example', 'https://user@school.example',
    'https://school.example/redirect', 'https://school.example/?code=a',
    'https://school.example/#fragment', 'https://school.example:777']) {
    assert.throws(() => strictOrigin(value), value);
  }
  assert.equal(strictOrigin('http://localhost:4801', true), 'http://localhost:4801');
});
test('webview navigation cannot leave the selected school origin', () => {
  assert.equal(trustedUrl('https://work.school.example/hello', 'https://work.school.example'), true);
  assert.equal(trustedUrl('https://work.school.example.evil.test/', 'https://work.school.example'), false);
  assert.equal(trustedUrl('http://work.school.example/', 'https://work.school.example'), false);
  assert.equal(trustedUrl('file:///etc/passwd', 'https://work.school.example'), false);
});
test('native callback must be an exact HTTPS claimed path', () => {
  const origin = 'https://mobile.educateos.io';
  assert.ok(appLink(origin + '/oauthredirect?state=ok', origin, '/oauthredirect'));
  for (const link of [origin + '/evil', origin.replace('https:', 'http:') + '/oauthredirect',
    origin + '.attacker.example/oauthredirect', origin + '/oauthredirect#state=ok']) {
    assert.equal(appLink(link, origin, '/oauthredirect'), null);
  }
});
test('callback parameters must not have duplicates', () => {
  assert.equal(uniqueParam(new URLSearchParams('state=abc'), 'state'), 'abc');
  assert.throws(() => uniqueParam(new URLSearchParams('state=a&state=b'), 'state'));
  assert.throws(() => uniqueParam(new URLSearchParams(), 'state'));
});
