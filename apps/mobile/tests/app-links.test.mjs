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
