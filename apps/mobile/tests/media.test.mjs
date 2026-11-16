import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioExtension, audioType, imageType, MAX_UPLOAD_BASE64, mediaKind, uploadTypeFor } from '../src/media.ts';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0]);
// An AAC .m4a as iOS and Android record it: a size, then the `ftyp` box and its brand.
const M4A = b64([0, 0, 0, 0x1c, ...Buffer.from('ftypM4A '), 0, 0, 0, 0]);
const WAV = b64([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')]);
const WEBM = b64([0x1a, 0x45, 0xdf, 0xa3, 0, 0]);

test('only PNG and JPEG bytes are drawn as images', () => {
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(imageType(JPEG), 'image/jpeg');
  assert.equal(imageType(b64(Buffer.from('%PDF-1.7'))), null);
  assert.equal(imageType(b64(Buffer.from('<svg onload=x>'))), null);
});

test('audio is recognised by the signatures the district checks', () => {
  assert.equal(audioType(M4A), 'audio/mp4');
  assert.equal(audioType(WAV), 'audio/wav');
  assert.equal(audioType(WEBM), 'audio/webm');
  assert.equal(audioType(b64(Buffer.from('ID3\x04'))), 'audio/mpeg');
  assert.equal(audioType(b64(Buffer.from('OggS\0\0'))), 'audio/ogg');
  assert.equal(audioType(PNG), null);
  assert.equal(audioType('not base64!!'), null);
  assert.equal(audioExtension(M4A), '.m4a');
  assert.equal(audioExtension(WAV), '.wav');
});

test('phone work uploads as its real type, and never a file the district would refuse', () => {
  assert.equal(uploadTypeFor('picture', PNG), 'image/png');
  assert.equal(uploadTypeFor('picture', JPEG), 'image/jpeg');
  assert.equal(uploadTypeFor('picture', M4A), null);
  assert.equal(uploadTypeFor('recording', M4A), 'audio/mp4');
  assert.equal(uploadTypeFor('recording', WAV), null, 'the phone records m4a only');
  assert.equal(uploadTypeFor('recording', ''), null);
  assert.equal(uploadTypeFor('recording', M4A + 'A'.repeat(MAX_UPLOAD_BASE64)), null);
});

test('submitted work is shown as a picture or played as audio only when its bytes are', () => {
  assert.equal(mediaKind(PNG), 'image');
  assert.equal(mediaKind(M4A), 'audio');
  assert.equal(mediaKind(WAV), 'audio');
  assert.equal(mediaKind(WEBM), null, 'WebM does not play on iOS');
  assert.equal(mediaKind(b64(Buffer.from('%PDF-1.7'))), null);
});
