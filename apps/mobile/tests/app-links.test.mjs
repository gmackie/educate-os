import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config, { VARIANTS, appConfig, appVariant } from '../app.config.ts';

test('HTTPS auth callback is authorized by both the native entitlement and webcredentials AASA service', () => {
  const host = 'mobile.educateos.io';
  const aasa = JSON.parse(readFileSync(new URL('../app-links/.well-known/apple-app-site-association', import.meta.url)));
  assert.ok(config.ios.associatedDomains.includes('webcredentials:' + host));
  assert.ok(config.ios.associatedDomains.includes('applinks:' + host));
  for (const variant of Object.keys(VARIANTS)) {
    const appId = 'P4SWQXAB5H.' + appConfig(variant).ios.bundleIdentifier;
    assert.ok(aasa.webcredentials.apps.includes(appId), appId);
    assert.ok(aasa.applinks.details.some(detail => detail.appIDs.includes(appId)), appId);
  }
});

test('each build variant has its own identifiers, and only production carries the store identity', () => {
  const ids = Object.keys(VARIANTS).map(variant => appConfig(variant));
  for (const built of ids) assert.equal(built.ios.bundleIdentifier, built.android.package);
  assert.equal(new Set(ids.map(built => built.ios.bundleIdentifier)).size, ids.length);
  assert.equal(appConfig('production').ios.bundleIdentifier, 'io.educateos.mobile');
  assert.equal(appConfig('preview').ios.bundleIdentifier, 'com.gmacko.educateos.preview');
  assert.equal(appConfig('development').ios.bundleIdentifier, 'com.gmacko.educateos.dev');
  assert.equal(appVariant(undefined), 'development');
  assert.equal(appVariant(''), 'development');
  assert.throws(() => appVariant('staging'), /APP_VARIANT/);
  const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));
  for (const variant of Object.keys(VARIANTS)) assert.equal(eas.build[variant].env.APP_VARIANT, variant);
});

test('the /j pairing QR opens the app on iOS and Android', () => {
  const aasa = JSON.parse(readFileSync(new URL('../app-links/.well-known/apple-app-site-association', import.meta.url)));
  const paths = aasa.applinks.details.flatMap(detail => detail.components.map(component => component['/']));
  for (const path of ['/oauthredirect', '/authpopup', '/enroll', '/pair-phone', '/j']) assert.ok(paths.includes(path), path);
  const filter = config.android.intentFilters.find(f => f.autoVerify);
  assert.ok(filter.data.some(d => d.scheme === 'https' && d.host === 'mobile.educateos.io' && d.path === '/j'));
  assert.ok(readFileSync(new URL('../app-links/j.html', import.meta.url), 'utf8').includes('/open-app.js'));
  assert.match(config.ios.infoPlist.NSCameraUsageDescription, /scan your school's QR code/i);
  assert.equal(config.userInterfaceStyle, 'automatic');
});
