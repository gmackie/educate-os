/** The image type of base64 bytes, by their signature; anything else is not drawn as an image. */
export function imageType(base64: string): 'image/png' | 'image/jpeg' | null {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  return null;
}
