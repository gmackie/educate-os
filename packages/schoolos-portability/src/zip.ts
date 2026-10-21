import { SchoolOsError } from "@schoolos/contracts";

/**
 * A minimal ZIP writer and a strict, bounded reader for the `.schoolos` archive. Only the subset
 * the writer produces is accepted: one disk, no ZIP64, no encryption, no data descriptors, no
 * extra fields or comments, store or raw deflate, and entries laid out back to back in central
 * directory order. Anything else is refused rather than interpreted, which is what keeps the
 * reader small enough to trust against hostile input.
 */

/** One file in an archive. */
export interface ZipEntry {
  /** The entry's path, `/`-separated. */
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** The limits {@link readZip} enforces. Every one is checked before or while bytes are inflated. */
export interface ZipLimits {
  /** The most entries an archive may hold. */
  maxEntries: number;
  /** The largest an entry may be once inflated. */
  maxEntryBytes: number;
  /** The most all entries together may inflate to. */
  maxTotalBytes: number;
  /**
   * The highest inflated-to-compressed ratio an entry larger than {@link ZipLimits.ratioFloorBytes}
   * may have. Ordinary documents compress by well under 20x; a bomb by hundreds.
   */
  maxRatio: number;
  /** Entries no larger than this inflated are exempt from the ratio check. */
  ratioFloorBytes: number;
}

/** The limits `.schoolos` archives are read under. */
export const ARCHIVE_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRatio: 100,
  ratioFloorBytes: 1024 * 1024,
};

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const STORE = 0;
const DEFLATE = 8;
/** General-purpose flag bit 11: the entry name is UTF-8. The only flag the writer sets or the reader accepts. */
const UTF8_FLAG = 0x0800;
/** 1980-01-01 00:00:00 in MS-DOS date format; every entry carries it so bytes never depend on the clock. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 ZIP records for each entry. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function transform(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/**
 * Writes `entries` as a ZIP, in the order given. The output depends on nothing but the entries:
 * every timestamp is the DOS epoch, and an entry is deflated only when that makes it smaller.
 * Callers order the entries; the archive writer sorts them.
 */
export async function writeZip(entries: readonly ZipEntry[]): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const deflated = await transform(entry.bytes, new CompressionStream("deflate-raw"));
    const useDeflate = deflated.byteLength < entry.bytes.byteLength;
    const data = useDeflate ? deflated : entry.bytes;
    const method = useDeflate ? DEFLATE : STORE;
    const crc = crc32(entry.bytes);

    const local = new DataView(new ArrayBuffer(LOCAL_HEADER_BYTES));
    local.setUint32(0, LOCAL_SIGNATURE, true);
    local.setUint16(4, useDeflate ? 20 : 10, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, method, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.byteLength, true);
    local.setUint32(22, entry.bytes.byteLength, true);
    local.setUint16(26, name.byteLength, true);
    local.setUint16(28, 0, true);

    const header = new DataView(new ArrayBuffer(CENTRAL_HEADER_BYTES));
    header.setUint32(0, CENTRAL_SIGNATURE, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, useDeflate ? 20 : 10, true);
    header.setUint16(8, UTF8_FLAG, true);
    header.setUint16(10, method, true);
    header.setUint16(12, DOS_TIME, true);
    header.setUint16(14, DOS_DATE, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, data.byteLength, true);
    header.setUint32(24, entry.bytes.byteLength, true);
    header.setUint16(28, name.byteLength, true);
    // Extra field, comment, disk number, internal and external attributes are all zero.
    header.setUint32(42, offset, true);

    parts.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(header.buffer), name);
    offset += LOCAL_HEADER_BYTES + name.byteLength + data.byteLength;
  }
  const centralBytes = central.reduce((n, part) => n + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(END_RECORD_BYTES));
  end.setUint32(0, END_SIGNATURE, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralBytes, true);
  end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

/** Concatenates byte arrays. */
export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * Whether `path` is a safe relative entry name: lowercase ASCII segments separated by single
 * slashes, none empty, `.` or `..`, and none starting with a dot. Absolute paths, backslashes,
 * drive letters and control characters all fail.
 */
export function isSafeEntryPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  return path.split("/").every((segment) => /^[a-z0-9][a-z0-9._-]{0,99}$/.test(segment) && !segment.includes(".."));
}

function invalid(message: string): SchoolOsError {
  return new SchoolOsError("validation-failed", `This is not a valid SchoolOS archive: ${message}.`);
}

/**
 * Reads a ZIP written by {@link writeZip}, refusing it whole if it breaks any of `limits` or uses
 * any feature outside the writer's subset. Inflation stops as soon as an entry produces more bytes
 * than it declared, so neither a lying header nor a high-ratio bomb is ever fully expanded.
 */
export async function readZip(bytes: Uint8Array<ArrayBuffer>, limits: ZipLimits = ARCHIVE_LIMITS): Promise<ZipEntry[]> {
  if (bytes.byteLength < END_RECORD_BYTES) throw invalid("it is too short to be a ZIP file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // No archive comment is allowed, so the end record is exactly the last 22 bytes.
  const endAt = bytes.byteLength - END_RECORD_BYTES;
  if (view.getUint32(endAt, true) !== END_SIGNATURE) throw invalid("it has no end-of-archive record, or has a comment");
  const count = view.getUint16(endAt + 10, true);
  const centralSize = view.getUint32(endAt + 12, true);
  const centralAt = view.getUint32(endAt + 16, true);
  if (view.getUint16(endAt + 4, true) !== 0 || view.getUint16(endAt + 6, true) !== 0 || view.getUint16(endAt + 8, true) !== count) {
    throw invalid("it spans more than one disk");
  }
  if (count > limits.maxEntries) throw invalid(`it has more than ${limits.maxEntries} entries`);
  if (centralAt + centralSize !== endAt) throw invalid("its central directory is not where the end record says");

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = centralAt;
  let expectedLocal = 0;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + CENTRAL_HEADER_BYTES > endAt || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw invalid("its central directory is corrupt");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localAt = view.getUint32(cursor + 42, true);
    if (flags !== UTF8_FLAG) throw invalid("an entry is encrypted or uses unsupported flags");
    if (method !== STORE && method !== DEFLATE) throw invalid("an entry uses an unsupported compression method");
    if (extraLength !== 0 || commentLength !== 0) throw invalid("an entry has extra fields or a comment");
    if (cursor + CENTRAL_HEADER_BYTES + nameLength > endAt) throw invalid("its central directory is corrupt");
    const nameBytes = bytes.subarray(cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameLength);
    let path: string;
    try {
      path = strictUtf8.decode(nameBytes);
    } catch {
      throw invalid("an entry name is not UTF-8");
    }
    if (!isSafeEntryPath(path)) throw invalid(`the entry name ${JSON.stringify(path.slice(0, 100))} is not a safe relative path`);
    if (seen.has(path)) throw invalid(`the entry ${path} appears twice`);
    seen.add(path);
    if (size > limits.maxEntryBytes) throw invalid(`the entry ${path} is larger than ${limits.maxEntryBytes} bytes`);
    total += size;
    if (total > limits.maxTotalBytes) throw invalid(`its entries total more than ${limits.maxTotalBytes} bytes`);
    if (size > limits.ratioFloorBytes && size > compressedSize * limits.maxRatio) throw invalid(`the entry ${path} is compressed suspiciously far`);
    if (method === STORE && size !== compressedSize) throw invalid(`the stored entry ${path} has inconsistent sizes`);

    // Entries must be contiguous and in directory order, so no two can share or overlap bytes.
    if (localAt !== expectedLocal) throw invalid("its entries overlap or are out of order");
    const dataAt = localAt + LOCAL_HEADER_BYTES + nameLength;
    const dataEnd = dataAt + compressedSize;
    if (dataEnd > centralAt || view.getUint32(localAt, true) !== LOCAL_SIGNATURE) throw invalid(`the entry ${path} is truncated`);
    if (
      view.getUint16(localAt + 6, true) !== flags
      || view.getUint16(localAt + 8, true) !== method
      || view.getUint32(localAt + 14, true) !== crc
      || view.getUint32(localAt + 18, true) !== compressedSize
      || view.getUint32(localAt + 22, true) !== size
      || view.getUint16(localAt + 26, true) !== nameLength
      || view.getUint16(localAt + 28, true) !== 0
      || !equalBytes(bytes.subarray(localAt + LOCAL_HEADER_BYTES, dataAt), nameBytes)
    ) {
      throw invalid(`the entry ${path} has a local header that disagrees with the directory`);
    }
    const data = bytes.slice(dataAt, dataEnd);
    const content = method === STORE ? data : await inflateBounded(data, size, path);
    if (content.byteLength !== size || crc32(content) !== crc) throw invalid(`the entry ${path} failed its checksum`);
    entries.push({ path, bytes: content });
    expectedLocal = dataEnd;
    cursor += CENTRAL_HEADER_BYTES + nameLength;
  }
  if (expectedLocal !== centralAt || cursor !== endAt) throw invalid("it has bytes outside its entries");
  return entries;
}

/** Inflates raw deflate data, giving up as soon as it yields more than `declared` bytes. */
async function inflateBounded(data: Uint8Array<ArrayBuffer>, declared: number, path: string): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let produced = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      produced += value.byteLength;
      if (produced > declared) {
        await reader.cancel();
        throw invalid(`the entry ${path} inflates to more than it declares`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SchoolOsError) throw error;
    throw invalid(`the entry ${path} is not valid deflate data`);
  }
  return concat(chunks);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}
