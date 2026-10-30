import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSchoolManifest, parseSchoolManifest, speaksMobileApi, supportsPhoneSignIn } from '../src/manifest.ts';
import { districtFromManifest, legacyDistrict, migrateDistrict, normalizeDistricts, workspaceOrigin } from '../src/schools.ts';
import { classifyIncomingUrl, onPendingLink, setPendingLink, takePendingLink } from '../src/links.ts';
import { directoryVisible, parseDirectoryResults, readDirectoryConfig } from '../src/directory.ts';
import { normalizeAddress } from '../src/security.ts';

const ORIGIN = 'https://northfield.educateos.io';
const manifest = () => ({
  v: 1, name: 'Northfield Public Schools', origin: ORIGIN,
  brand: { logo: ORIGIN + '/brand/logo.svg', accent: '#2458ac' },
  signIn: [{ id: 'google', label: 'Google' }, { id: 'clever', label: 'Clever' }],
  features: { ai: true, mobile: true, family: true },
  mobileApi: { min: 1, max: 1 }, release: 'r000042-ade9299',
});

test('the ADR-0014 example manifest is accepted as is', () => {
  assert.deepEqual(parseSchoolManifest(manifest(), ORIGIN), manifest());
  assert.ok(speaksMobileApi(parseSchoolManifest(manifest(), ORIGIN)));
  const plain = { ...manifest(), brand: { logo: null, accent: null }, signIn: [], release: null };
  assert.deepEqual(parseSchoolManifest(plain, ORIGIN), plain);
});

test('manifests are validated strictly', () => {
  const bad = [
    { ...manifest(), v: 2 },
    { ...manifest(), extra: true },
    { ...manifest(), origin: 'http://northfield.educateos.io' },
    { ...manifest(), origin: ORIGIN + '/' },
    { ...manifest(), origin: 'https://user@northfield.educateos.io' },
    { ...manifest(), name: '' },
    { ...manifest(), brand: { logo: 'http://x.example/logo.svg', accent: null } },
    { ...manifest(), brand: { logo: null, accent: 'red' } },
    { ...manifest(), brand: { logo: null, accent: null, extra: 1 } },
    { ...manifest(), signIn: [{ id: 'Google!', label: 'Google' }] },
    { ...manifest(), signIn: [{ id: 'google' }] },
    { ...manifest(), features: { ai: 'yes', mobile: true, family: true } },
    { ...manifest(), mobileApi: { min: 2, max: 1 } },
    { ...manifest(), release: 42 },
    null, [], 'manifest',
  ];
  for (const value of bad) assert.throws(() => parseSchoolManifest(value, ORIGIN), /valid EducateOS school/, JSON.stringify(value));
  assert.throws(() => parseSchoolManifest(manifest(), 'https://other.example'), /different address: https:\/\/northfield/);
});

test('capabilities: device API version and phone sign-in without a computer', () => {
  const m = parseSchoolManifest(manifest(), ORIGIN);
  assert.equal(supportsPhoneSignIn(m), false, 'v1 districts show "coming soon"');
  assert.equal(supportsPhoneSignIn({ ...m, mobileApi: { min: 1, max: 2 } }), true);
  assert.equal(supportsPhoneSignIn({ ...m, mobileApi: { min: 1, max: 2 }, signIn: [] }), false);
  assert.equal(speaksMobileApi({ ...m, mobileApi: { min: 2, max: 3 } }), false);
});

test('fetching a manifest never follows redirects and reports failures kindly', async (t) => {
  const fetch = t.mock.fn(async () => Response.json(manifest()));
  assert.equal((await fetchSchoolManifest(ORIGIN, { fetch })).name, 'Northfield Public Schools');
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, ORIGIN + '/.well-known/educateos.json');
  assert.equal(init.redirect, 'manual');
  await assert.rejects(fetchSchoolManifest(ORIGIN, { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }) }), /isn't an EducateOS school/);
  await assert.rejects(fetchSchoolManifest(ORIGIN, { fetch: async () => { throw new TypeError('Network request failed'); } }), /couldn't reach/);
  await assert.rejects(fetchSchoolManifest(ORIGIN, { fetch: async () => new Response('x'.repeat(70_000)) }), /valid EducateOS school/);
  await assert.rejects(fetchSchoolManifest('https://northfield.educateos.io/path', { fetch }), /origin only/);
});

test('saved two-address schools migrate to one origin', () => {
  const same = migrateDistrict({ id: ORIGIN + '|' + ORIGIN, name: 'Northfield', portal: ORIGIN, workshop: ORIGIN });
  assert.deepEqual(same, { id: ORIGIN + '|' + ORIGIN, name: 'Northfield', origin: ORIGIN, workshop: ORIGIN + '/ai/', legacy: true });
  const split = migrateDistrict({ id: 'https://schoolos.gmac.io|https://harbor.educateos.io', name: 'Harbor', portal: 'https://harbor.educateos.io', workshop: 'https://schoolos.gmac.io' });
  assert.equal(split.origin, 'https://harbor.educateos.io');
  assert.equal(split.workshop, 'https://schoolos.gmac.io/', 'a separate legacy Workshop origin is kept');
  assert.equal(workspaceOrigin(split), 'https://schoolos.gmac.io');
  assert.equal(split.id, 'https://schoolos.gmac.io|https://harbor.educateos.io', 'the id keys its stored sign-in');
  for (const bad of [
    { id: 'x', name: 'Bad', portal: ORIGIN, workshop: ORIGIN },
    { id: 'http://a.example|http://a.example', name: 'Bad', portal: 'http://a.example', workshop: 'http://a.example' },
    { id: ORIGIN, name: 'N', origin: ORIGIN, workshop: 'https://evil.example/ai/' },
    { id: ORIGIN, name: 'Northfield', origin: ORIGIN + '/', workshop: ORIGIN + '/ai/' },
  ]) assert.equal(migrateDistrict(bad), null, JSON.stringify(bad));
  const fresh = districtFromManifest(parseSchoolManifest(manifest(), ORIGIN));
  assert.deepEqual(migrateDistrict(JSON.parse(JSON.stringify(fresh))), fresh);
  assert.deepEqual(normalizeDistricts([fresh, same, 'junk', split]).map((d) => d.origin), [ORIGIN, 'https://harbor.educateos.io'], 'one entry per origin');
  assert.deepEqual(normalizeDistricts('nope'), []);
  assert.equal(legacyDistrict({ name: 'Harbor', portal: 'https://harbor.educateos.io', workshop: 'https://schoolos.gmac.io' }).legacy, true);
});

test('incoming links are classified without putting codes in routes', () => {
  const join = 'https://mobile.educateos.io/j#' + new URLSearchParams({ o: ORIGIN, r: 'room_' + 'a'.repeat(12), s: 'b'.repeat(32) });
  assert.deepEqual(classifyIncomingUrl(join), { kind: 'join', join: { origin: ORIGIN, room: 'room_' + 'a'.repeat(12), secret: 'b'.repeat(32) } });
  assert.equal(classifyIncomingUrl(join.replace('#', '?')).kind, 'invalid');
  assert.equal(classifyIncomingUrl('https://mobile.educateos.io/oauthredirect?state=x').kind, 'auth-callback');
  assert.equal(classifyIncomingUrl('https://mobile.educateos.io/authpopup#id=x').kind, 'auth-callback');
  assert.equal(classifyIncomingUrl('educateos://class/123').kind, 'route');
  assert.equal(classifyIncomingUrl('https://mobile.educateos.io/whatever').kind, 'invalid');
  assert.equal(classifyIncomingUrl('https://mobile.educateos.io/enroll#name=Harbor&portal=https%3A%2F%2Fharbor.educateos.io&workshop=https%3A%2F%2Fschoolos.gmac.io').kind, 'enroll');
  const seen = [];
  const stop = onPendingLink((l) => seen.push(l.kind));
  setPendingLink({ kind: 'invalid', message: 'x' });
  stop();
  assert.deepEqual(seen, ['invalid']);
  assert.equal(takePendingLink().kind, 'invalid');
  assert.equal(takePendingLink(), null, 'taken once');
});

test('Find my school is off by default and keeps only exact HTTPS origins', () => {
  assert.equal(directoryVisible(readDirectoryConfig({})), false);
  assert.equal(directoryVisible(readDirectoryConfig({ schoolDirectory: { enabled: false, url: 'https://educateos.io/x' } })), false);
  assert.equal(directoryVisible(readDirectoryConfig({ schoolDirectory: { enabled: true, url: 'http://educateos.io/x' } })), false);
  assert.equal(directoryVisible(readDirectoryConfig({ schoolDirectory: { enabled: true, url: 'https://educateos.io/x' } })), true);
  assert.deepEqual(parseDirectoryResults({ schools: [
    { name: 'Northfield', origin: ORIGIN }, { name: 'Path', origin: ORIGIN + '/x' }, { name: 'Plain', origin: 'http://a.example' }, 7,
  ] }), [{ name: 'Northfield', origin: ORIGIN }]);
  assert.throws(() => parseDirectoryResults({}));
});

test('a typed web address becomes one HTTPS origin', () => {
  assert.equal(normalizeAddress(' northfield.educateos.io '), ORIGIN);
  assert.equal(normalizeAddress('https://northfield.educateos.io/'), ORIGIN);
  for (const bad of ['http://northfield.educateos.io', 'northfield.educateos.io/login', 'javascript:alert(1)', 'https://a@b.example']) {
    assert.throws(() => normalizeAddress(bad), bad);
  }
});
