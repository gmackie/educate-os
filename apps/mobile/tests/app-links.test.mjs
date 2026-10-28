import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../app.config.ts';

test('HTTPS auth callback is authorized by both the native entitlement and webcredentials AASA service', () => {
  const host = 'mobile.educateos.io';
  const aasa = JSON.parse(readFileSync(new URL('../app-links/.well-known/apple-app-site-association', import.meta.url)));
  assert.ok(config.ios.associatedDomains.includes('webcredentials:' + host));
  assert.ok(config.ios.associatedDomains.includes('applinks:' + host));
  assert.ok(aasa.webcredentials.apps.includes('P4SWQXAB5H.' + config.ios.bundleIdentifier));
  assert.ok(aasa.applinks.details.some(detail => detail.appIDs.includes('P4SWQXAB5H.' + config.ios.bundleIdentifier)));
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
