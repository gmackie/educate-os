import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../app.config.ts';

/** Width, height and PNG colour type from the IHDR chunk (2 = RGB, 6 = RGBA). */
function png(path) {
  const bytes = readFileSync(new URL('../' + path, import.meta.url));
  assert.equal(bytes.toString('latin1', 1, 4), 'PNG', path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25] };
}

test('the app icons exist at store sizes, and the iOS icon is opaque', () => {
  // App Store Connect rejects an icon with an alpha channel.
  assert.deepEqual(png(config.icon), { width: 1024, height: 1024, colourType: 2 });
  const adaptive = config.android.adaptiveIcon;
  assert.deepEqual(png(adaptive.foregroundImage), { width: 1024, height: 1024, colourType: 2 });
  assert.deepEqual(png(adaptive.monochromeImage), { width: 1024, height: 1024, colourType: 6 });
  assert.equal(adaptive.backgroundColor, '#0035D3');
  const [, notifications] = config.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-notifications');
  assert.equal(png(notifications.icon).colourType, 6, 'Android notification icons are white on transparent');
});
