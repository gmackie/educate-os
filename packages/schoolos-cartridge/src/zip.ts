import { CartridgeRefusedError } from "./errors.ts";

/**
 * Caps on what reading one archive may cost. Each is checked against the archive's declared sizes
 * before anything is inflated, and again against the bytes actually produced, which must match
 * what was declared.
 */
export interface ZipLimits {
  /** The most entries the central directory may list, directories and ignored entries included. */
  maxEntries: number;
  /** The largest uncompressed size of one entry, in bytes. */
  maxEntryBytes: number;
  /** The largest uncompressed size of all entries together, in bytes. */
  maxTotalBytes: number;
  /** The largest uncompressed-to-compressed ratio of an entry above {@link RATIO_FLOOR_BYTES}. */
  maxCompressionRatio: number;
}

/**
 * Generous for a Thin CC, which holds a manifest and one small XML file per link, and far below
 * what a Worker can hold in memory.
 */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 100,
};

/** Entries this small are exempt from the ratio cap: short repetitive XML legitimately compresses well. */
export const RATIO_FLOOR_BYTES = 64 * 1024;

/** An entry that was listed but deliberately not read. */
export interface IgnoredZipEntry {
  path: string;
  reason: "symlink";
}

/** An archive's regular files by path, and the entries that were skipped. Directories are dropped. */
export interface ZipArchive {
  files: ReadonlyMap<string, Uint8Array>;
  ignored: IgnoredZipEntry[];
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_LENGTH = 22;
const MAX_COMMENT = 0xffff;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
/** Compressed input is fed in slices this size, so one slice inflates to at most about 4 MiB. */
const INPUT_SLICE = 4096;

interface CentralEntry {
  path: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  symlink: boolean;
}

/**
 * Reads a ZIP archive within `limits`. Only stored and deflated entries are supported, which is
 * all a cartridge uses. The whole archive is refused, rather than partly read, on any entry with an
 * unsafe path (absolute, drive-qualified, backslashed, or with `.`, `..` or empty segments), any
 * encrypted, ZIP64, duplicate or overlapping entry, a size or ratio over the caps, or content that
 * does not match its declared size and CRC. Symbolic links are listed in {@link ZipArchive.ignored}
 * and never read.
 *
 * @throws CartridgeRefusedError naming the check that failed.
 */
export async function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipArchive> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new CartridgeRefusedError("zip64-unsupported", "ZIP64 archives are not accepted");
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new CartridgeRefusedError("multi-disk-unsupported", "split archives are not accepted");
  }
  if (entryCount > limits.maxEntries) {
    throw new CartridgeRefusedError("too-many-entries", `the archive lists ${entryCount} entries; at most ${limits.maxEntries} are accepted`);
  }
  if (centralOffset + centralSize > eocd) throw new CartridgeRefusedError("not-a-zip", "the central directory is out of bounds");

  const entries = readCentralDirectory(view, centralOffset, centralOffset + centralSize, entryCount, limits);
  checkNoOverlap(view, entries, centralOffset);

  const files = new Map<string, Uint8Array>();
  const ignored: IgnoredZipEntry[] = [];
  for (const entry of entries) {
    if (entry.symlink) {
      ignored.push({ path: entry.path, reason: "symlink" });
      continue;
    }
    if (entry.path.endsWith("/")) continue;
    const start = dataStart(view, entry);
    const data = bytes.subarray(start, start + entry.compressedSize);
    const content = entry.method === 0 ? data.slice() : await inflateRaw(data, entry.size);
    if (content.byteLength !== entry.size) throw new CartridgeRefusedError("corrupt-entry", `${entry.path} does not match its declared size`);
    if (crc32(content) !== entry.crc) throw new CartridgeRefusedError("corrupt-entry", `${entry.path} fails its checksum`);
    files.set(entry.path, content);
  }
  return { files, ignored };
}

function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - EOCD_LENGTH - MAX_COMMENT);
  for (let at = view.byteLength - EOCD_LENGTH; at >= lowest; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE && at + EOCD_LENGTH + view.getUint16(at + 20, true) === view.byteLength) return at;
  }
  throw new CartridgeRefusedError("not-a-zip", "no ZIP end-of-central-directory record");
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function readCentralDirectory(view: DataView, start: number, end: number, count: number, limits: ZipLimits): CentralEntry[] {
  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let at = start;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new CartridgeRefusedError("not-a-zip", "a central directory record is malformed");
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const externalAttributes = view.getUint32(at + 38, true);
    const localOffset = view.getUint32(at + 42, true);
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > end) throw new CartridgeRefusedError("not-a-zip", "a central directory record is malformed");
    const path = decodeName(new Uint8Array(view.buffer, view.byteOffset + at + 46, nameLength));
    at = nameEnd + extraLength + commentLength;

    // Paths are checked before anything else, symbolic links included: a hostile name refuses the archive.
    assertSafePath(path);
    if (seen.has(path)) throw new CartridgeRefusedError("duplicate-entry", `${path} appears more than once`);
    seen.add(path);
    if (flags & 1) throw new CartridgeRefusedError("encrypted-entry", `${path} is encrypted`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new CartridgeRefusedError("zip64-unsupported", "ZIP64 archives are not accepted");
    }
    if (method !== 0 && method !== 8) throw new CartridgeRefusedError("unsupported-compression", `${path} uses compression method ${method}`);
    if (method === 0 && compressedSize !== size) throw new CartridgeRefusedError("corrupt-entry", `${path} is stored with mismatched sizes`);
    if (size > limits.maxEntryBytes) {
      throw new CartridgeRefusedError("entry-too-large", `${path} would inflate to ${size} bytes; at most ${limits.maxEntryBytes} are accepted`);
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new CartridgeRefusedError("package-too-large", `the archive would inflate to more than ${limits.maxTotalBytes} bytes`);
    }
    if (size > RATIO_FLOOR_BYTES && size > compressedSize * limits.maxCompressionRatio) {
      throw new CartridgeRefusedError("compression-ratio", `${path} compresses more than ${limits.maxCompressionRatio}:1`);
    }
    const symlink = madeBy >> 8 === UNIX_HOST && ((externalAttributes >>> 16) & S_IFMT) === S_IFLNK;
    entries.push({ path, method, crc, compressedSize, size, localOffset, symlink });
  }
  return entries;
}

function decodeName(raw: Uint8Array): string {
  try {
    return utf8.decode(raw);
  } catch {
    throw new CartridgeRefusedError("unsafe-path", "an entry name is not valid UTF-8");
  }
}

/**
 * Refuses a path that could name anything outside the archive's own tree, or be read differently
 * by another tool: absolute and drive-qualified paths, backslashes, control characters, and `.`,
 * `..` or empty segments. A trailing `/` marks a directory.
 */
export function assertSafePath(path: string): void {
  const body = path.endsWith("/") ? path.slice(0, -1) : path;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  const unsafe = body.length === 0 || /[\\\u0000-\u001f\u007f]/.test(body) || /^[A-Za-z]:/.test(body)
    || body.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
  if (unsafe) throw new CartridgeRefusedError("unsafe-path", `the entry name ${JSON.stringify(path.slice(0, 200))} is not a safe relative path`);
}

function dataStart(view: DataView, entry: CentralEntry): number {
  return entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
}

/**
 * Checks each entry's local header and that entries' data do not overlap: overlapping entries are
 * how a small archive makes many large files out of the same compressed bytes.
 */
function checkNoOverlap(view: DataView, entries: readonly CentralEntry[], centralOffset: number): void {
  let previousEnd = 0;
  for (const entry of entries.toSorted((a, b) => a.localOffset - b.localOffset)) {
    if (entry.localOffset < previousEnd || entry.localOffset + 30 > centralOffset || view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
      throw new CartridgeRefusedError("corrupt-entry", `${entry.path} has no valid local header`);
    }
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    if (entry.localOffset + 30 + nameLength > centralOffset) throw new CartridgeRefusedError("corrupt-entry", `${entry.path} has no valid local header`);
    const localName = decodeName(new Uint8Array(view.buffer, view.byteOffset + entry.localOffset + 30, nameLength));
    if (localName !== entry.path) throw new CartridgeRefusedError("corrupt-entry", `${entry.path} is named differently in its local header`);
    const end = dataStart(view, entry) + entry.compressedSize;
    if (end > centralOffset) throw new CartridgeRefusedError("corrupt-entry", `${entry.path} runs past the end of the data`);
    previousEnd = end;
  }
}

/**
 * Inflates raw deflate data that must produce exactly `expected` bytes. Input is fed in small
 * slices and output is counted as it arrives, so data that inflates beyond what its header
 * declared is stopped as soon as it passes `expected`, never held in full.
 */
async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const feeding = (async () => {
    for (let at = 0; at < data.byteLength; at += INPUT_SLICE) {
      await writer.ready;
      await writer.write(data.subarray(at, at + INPUT_SLICE));
    }
    await writer.close();
  })();
  // A failed write surfaces through the reader as well; this keeps it from going unhandled.
  feeding.catch(() => {});
  const out = new Uint8Array(expected);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > expected) throw new CartridgeRefusedError("corrupt-entry", "an entry inflates beyond its declared size");
      out.set(value, length);
      length += value.byteLength;
    }
    await feeding;
  } catch (error) {
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    if (error instanceof CartridgeRefusedError) throw error;
    throw new CartridgeRefusedError("corrupt-entry", "an entry is not valid deflate data");
  }
  return out.subarray(0, length);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 a ZIP entry declares for its uncompressed content. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
