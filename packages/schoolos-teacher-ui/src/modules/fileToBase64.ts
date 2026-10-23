/** The largest cartridge the district accepts, in bytes. Checked here so a teacher isn't left waiting on an upload it will refuse. */
export const MAX_CARTRIDGE_BYTES = 5 * 1024 * 1024;

/** A file's bytes as base64, for a JSON request body. */
export const fileToBase64 = async (file: Blob): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In chunks: spreading a whole file into one call overflows the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
