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
test('loopback school addresses are refused outside development builds', () => {
  // __DEV__ is undefined here, as it is false in release builds.
  assert.throws(() => strictOrigin('http://localhost:4810'));
  assert.throws(() => strictOrigin('http://127.0.0.1:4810'));
});
test('Array.prototype.toSorted exists after the polyfill, and leaves the array alone', async () => {
  await import('../src/polyfills.ts');
  const list = [3, 1, 2];
  assert.deepEqual(list.toSorted((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual(list, [3, 1, 2]);
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

test('QR enrollment accepts public HTTPS school details and rejects ambiguous or credential-bearing links', async () => {
  const { parseEnrollmentLink } = await import('../src/security.ts');
  const valid = 'educateos://enroll?name=Harbor&portal=https%3A%2F%2Fharbor.educateos.io&workshop=https%3A%2F%2Fschoolos.gmac.io';
  assert.deepEqual(parseEnrollmentLink(valid), { name: 'Harbor', portal: 'https://harbor.educateos.io', workshop: 'https://schoolos.gmac.io' });
  for (const value of [valid + '&name=Other', valid + '&token=secret', valid + '#secret',
    valid.replace('educateos:', 'https:'), valid.replace('enroll?', 'enroll/other?'),
    valid.replace('https%3A%2F%2Fharbor', 'http%3A%2F%2Fharbor')]) assert.throws(() => parseEnrollmentLink(value));
});

test('computer pairing QR is bounded to one school and a strong relay capability', async () => {
  const { parsePairingLink } = await import('../src/security.ts');
  const value = 'educateos://pair?' + new URLSearchParams({ name: 'Harbor', portal: 'https://harbor.educateos.io', workshop: 'https://schoolos.gmac.io', id: 'b5cd3cd4-e8c5-4c44-a7c0-a24d8554278b', secret: 'a'.repeat(64) });
  assert.equal(parsePairingLink(value).name, 'Harbor');
  for (const bad of [value + '&secret=' + 'b'.repeat(64), value + '&token=credential', value.replace('educateos:', 'https:'), value + '#secret', value.replace('a'.repeat(64), 'short')]) assert.throws(() => parsePairingLink(bad));
});

test('HTTPS QR fragments open enrollment and pairing without accepting foreign hosts', async () => {
  const { parseEnrollmentLink, parsePairingLink } = await import('../src/security.ts');
  const details = new URLSearchParams({ name: 'Harbor', portal: 'https://harbor.educateos.io', workshop: 'https://schoolos.gmac.io' });
  const enroll = 'https://mobile.educateos.io/enroll#' + details;
  assert.equal(parseEnrollmentLink(enroll).name, 'Harbor');
  details.set('id', 'b5cd3cd4-e8c5-4c44-a7c0-a24d8554278b'); details.set('secret', 'a'.repeat(64));
  const pair = 'https://mobile.educateos.io/pair-phone#' + details;
  assert.equal(parsePairingLink(pair).secret, 'a'.repeat(64));
  assert.throws(() => parseEnrollmentLink(enroll.replace('mobile.educateos.io', 'evil.example')));
  assert.throws(() => parsePairingLink(pair.replace('mobile.educateos.io', 'evil.example')));
  assert.throws(() => parsePairingLink(pair.replace('/pair-phone#', '/pair-phone?secret=other#')));
});

test('the one-origin pairing QR (/j) accepts one exact HTTPS school origin and nothing else', async () => {
  const { parseJoinLink } = await import('../src/security.ts');
  const params = { o: 'https://northfield.educateos.io', r: 'room_' + 'A'.repeat(20), s: 'x'.repeat(43) };
  const qr = 'https://mobile.educateos.io/j#' + new URLSearchParams(params);
  assert.deepEqual(parseJoinLink(qr), { origin: params.o, room: params.r, secret: params.s });
  assert.deepEqual(parseJoinLink('educateos://j?' + new URLSearchParams(params)), parseJoinLink(qr));
  const fragment = (over) => 'https://mobile.educateos.io/j#' + new URLSearchParams({ ...params, ...over });
  for (const bad of [
    qr.replace('mobile.educateos.io', 'evil.example'),                 // foreign QR host
    qr.replace('mobile.educateos.io', 'mobile.educateos.io.evil.example'),
    qr.replace('https://', 'http://'),
    qr.replace('https://', 'https://user:pass@'),                      // credentials on the QR host
    qr.replace('/j#', '/j?s=other#'),                                  // a query alongside the fragment
    qr.replace('/j#', '/join#'),
    'https://mobile.educateos.io/j',
    fragment({ o: 'http://northfield.educateos.io' }),                 // the school must be HTTPS
    fragment({ o: 'https://admin:pw@northfield.educateos.io' }),       // and carry no credentials
    fragment({ o: 'https://northfield.educateos.io/login' }),          // and be an origin, not a path
    fragment({ o: 'https://northfield.educateos.io:8443' }),
    fragment({ o: 'http://localhost:4801' }),
    fragment({ r: 'short' }), fragment({ s: 'tiny' }), fragment({ r: 'has spaces in it' }),
    qr + '&token=credential', qr + '&s=' + 'y'.repeat(43),
    'educateos://j?' + new URLSearchParams(params) + '#x',
    'educateos://pair?' + new URLSearchParams(params),
    'not a url',
  ]) assert.throws(() => parseJoinLink(bad), bad);
});
