import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageType } from '../src/media.ts';

test('only PNG and JPEG bytes are drawn as images', () => {
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]).toString('base64')), 'image/png');
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')), 'image/jpeg');
  assert.equal(imageType(Buffer.from('%PDF-1.7').toString('base64')), null);
  assert.equal(imageType(Buffer.from('<svg onload=x>').toString('base64')), null);
});
