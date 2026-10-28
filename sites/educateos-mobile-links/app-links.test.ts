import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANDROID_CERT_SHA256, ANDROID_PACKAGE, assetLinks } from './app-links.ts';

const assets = new URL('../../apps/mobile/app-links/', import.meta.url);

test('assetlinks.json is a valid Digital Asset Links statement for the app package', () => {
  const [statement, ...rest] = assetLinks();
  assert.equal(rest.length, 0);
  assert.deepEqual(statement.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(statement.target.namespace, 'android_app');
  assert.equal(statement.target.package_name, 'io.educateos.mobile');
  assert.deepEqual(statement.target.sha256_cert_fingerprints, [...ANDROID_CERT_SHA256]);
  const fingerprint = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
  assert.deepEqual(assetLinks([fingerprint])[0].target.sha256_cert_fingerprints, [fingerprint]);
  for (const bad of ['AB:CD', fingerprint.toLowerCase(), fingerprint.replaceAll(':', '')]) assert.throws(() => assetLinks([bad]));
});

test('the app config, AASA and Android statement name the same app and paths', async () => {
  const { default: config } = await import('../../apps/mobile/app.config.ts');
  assert.equal(config.android.package, ANDROID_PACKAGE);
  const aasa = JSON.parse(readFileSync(new URL('.well-known/apple-app-site-association', assets), 'utf8'));
  const paths = aasa.applinks.details.flatMap((d: { components: { '/': string }[] }) => d.components.map((c) => c['/']));
  const filter = config.android.intentFilters.find((f: { autoVerify?: boolean }) => f.autoVerify);
  const androidPaths = filter.data.map((d: { path?: string; pathPrefix?: string }) => d.path ?? d.pathPrefix);
  for (const path of ['/oauthredirect', '/authpopup', '/enroll', '/pair-phone', '/j']) {
    assert.ok(paths.includes(path), 'AASA ' + path);
    assert.ok(androidPaths.includes(path), 'Android ' + path);
  }
});

test('the landing pages exist and point people without the app at the get-the-app page', () => {
  for (const page of ['index.html', 'j.html', 'enroll.html', 'pair-phone.html']) {
    assert.ok(readFileSync(new URL(page, assets), 'utf8').includes('EducateOS'), page);
  }
  assert.match(readFileSync(new URL('index.html', assets), 'utf8'), /Get the EducateOS app/);
  assert.match(readFileSync(new URL('j.html', assets), 'utf8'), /href="\/"/);
});
