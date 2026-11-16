import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../app.config.ts';

const plugin = (name) => config.plugins.find((p) => Array.isArray(p) && p[0] === name)?.[1];

test('voice recording has a microphone description and an unblocked Android permission (SCHO-342)', () => {
  const usage = config.ios.infoPlist.NSMicrophoneUsageDescription;
  assert.ok(usage && usage.length > 20);
  assert.ok(config.android.permissions.includes('android.permission.RECORD_AUDIO'));
  assert.equal(config.android.blockedPermissions, undefined);
  // A plugin given `microphonePermission: false` deletes the iOS key and blocks RECORD_AUDIO app-wide.
  for (const name of ['expo-camera', 'expo-image-picker', 'expo-audio']) {
    assert.equal(plugin(name)?.microphonePermission, usage, name);
  }
  assert.equal(plugin('expo-audio').enableBackgroundRecording, false);
  assert.equal(plugin('expo-audio').enableBackgroundPlayback, false);
});
