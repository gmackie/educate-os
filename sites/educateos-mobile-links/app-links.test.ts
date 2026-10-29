import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANDROID_APPS, assetLinks } from './app-links.ts';

const assets = new URL('../../apps/mobile/app-links/', import.meta.url);

test('assetlinks.json has one valid Digital Asset Links statement per app package', () => {
  const statements = assetLinks();
  assert.equal(statements.length, ANDROID_APPS.length);
  // The store app first: older checks read the first statement.
  assert.equal(statements[0].target.package_name, 'io.educateos.mobile');
  for (const [i, statement] of statements.entries()) {
    assert.deepEqual(statement.relation, ['delegate_permission/common.handle_all_urls']);
    assert.equal(statement.target.namespace, 'android_app');
    assert.equal(statement.target.package_name, ANDROID_APPS[i].package);
    assert.deepEqual(statement.target.sha256_cert_fingerprints, [...ANDROID_APPS[i].sha256]);
    assert.ok(ANDROID_APPS[i].sha256.length > 0, 'publish at least the EAS signing certificate');
  }
  const all = ANDROID_APPS.flatMap((app) => app.sha256);
  assert.equal(new Set(all).size, all.length, 'each variant has its own keystore');
  const fingerprint = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
  assert.deepEqual(assetLinks([{ package: 'x.y', sha256: [fingerprint] }])[0].target.sha256_cert_fingerprints, [fingerprint]);
  for (const bad of ['AB:CD', fingerprint.toLowerCase(), fingerprint.replaceAll(':', '')]) {
    assert.throws(() => assetLinks([{ package: 'x.y', sha256: [bad] }]));
  }
});

test('the app config, AASA and Android statement name the same apps and paths', async () => {
  const { default: config, VARIANTS, appConfig } = await import('../../apps/mobile/app.config.ts');
  const aasa = JSON.parse(readFileSync(new URL('.well-known/apple-app-site-association', assets), 'utf8'));
  const ids = Object.values(VARIANTS).map((v: { id: string }) => v.id);
  assert.deepEqual(ANDROID_APPS.map((app) => app.package).toSorted(), ids.toSorted());
  for (const variant of Object.keys(VARIANTS)) {
    const appId = 'P4SWQXAB5H.' + appConfig(variant).ios.bundleIdentifier;
    assert.ok(aasa.applinks.details.every((d: { appIDs: string[] }) => d.appIDs.includes(appId)), 'AASA applinks ' + appId);
    assert.ok(aasa.webcredentials.apps.includes(appId), 'AASA webcredentials ' + appId);
  }
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
