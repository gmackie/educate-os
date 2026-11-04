import { base64 as b64 } from '@scure/base';
import type { UploadMediaType } from './types';

/** The district's upload limit (`MAX_UPLOAD_BYTES`): 5 MiB, sent as base64. */
export const MAX_UPLOAD_BASE64 = Math.ceil((5 * 1024 * 1024) / 3) * 4;

/** The image type of base64 bytes, by their signature; anything else is not drawn as an image. */
export function imageType(base64: string): 'image/png' | 'image/jpeg' | null {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  return null;
}

/** The first bytes of base64 content, or none if it is not base64. */
function head(base64: string, count: number): Uint8Array {
  // Whole four-character groups only, so a prefix of valid base64 is itself valid.
  const chars = Math.min(Math.ceil(count / 3) * 4, base64.length - (base64.length % 4));
  try { return b64.decode(base64.slice(0, chars)); } catch { return new Uint8Array(); }
}
const ascii = (bytes: Uint8Array, offset: number, text: string) =>
  bytes.length >= offset + text.length && [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));

/**
 * The audio type of base64 bytes, by the same signatures the district checks (`UPLOAD_SIGNATURES`),
 * or null. The phone records AAC in an MPEG-4 container (`.m4a`), which is `audio/mp4`.
 */
export function audioType(base64: string): 'audio/mp4' | 'audio/mpeg' | 'audio/wav' | 'audio/webm' | 'audio/ogg' | null {
  const bytes = head(base64, 12);
  if (ascii(bytes, 4, 'ftyp')) return 'audio/mp4';
  if (ascii(bytes, 0, 'ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return 'audio/wav';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm';
  if (ascii(bytes, 0, 'OggS')) return 'audio/ogg';
  return null;
}

/**
 * The media type to upload phone-made work as: a photo or drawing as its image type, a recording as
 * `audio/mp4`. Null when the bytes are not what the work should be, or are over the district's
 * limit, so the phone never sends a file the district would refuse.
 */
export function uploadTypeFor(work: 'picture' | 'recording', base64: string): UploadMediaType | null {
  if (base64.length === 0 || base64.length > MAX_UPLOAD_BASE64) return null;
  if (work === 'picture') return imageType(base64);
  return audioType(base64) === 'audio/mp4' ? 'audio/mp4' : null;
}

/**
 * How submitted bytes can be shown on the phone: as a picture, as audio to play, or not at all.
 * The signature decides, so a file claiming to be a picture is never drawn unless it is one.
 */
export function mediaKind(base64: string): 'image' | 'audio' | null {
  if (imageType(base64)) return 'image';
  // WebM and Ogg (from some browsers) do not play on iOS, so they are not offered.
  const audio = audioType(base64);
  return audio === 'audio/mp4' || audio === 'audio/mpeg' || audio === 'audio/wav' ? 'audio' : null;
}

/** A file extension for playable audio, so the platform player picks the right decoder. */
export function audioExtension(base64: string): string {
  const type = audioType(base64);
  return type === 'audio/mpeg' ? '.mp3' : type === 'audio/wav' ? '.wav' : '.m4a';
}
