// A deterministic ZIP writer (SCHO-186), for the packages EducateOS produces, such as a course's
// Common Cartridge export. It writes the subset the bounded reader (`readZip`) accepts: one disk,
// no ZIP64, no encryption, no data descriptors, no extra fields, store or raw deflate. Derived from
// the `.educateos` archive writer in `@educateos/portability`, which can move onto this one.
//
// `zipStream` (SCHO-367) writes the same layout as a stream, one entry in memory at a time, for an
// archive too large to build in memory. Past 65,534 entries or 4 GiB of offsets it adds the ZIP64
// records (an extra field giving a local header's offset, and the ZIP64 end records), which
// `readZip` refuses but every general-purpose unzip tool reads; below those it writes exactly what
// `writeZip` would.
import { crc32 } from "./zip.ts";

/** One file to write. */
export interface ZipWriteEntry {
  /** The entry's path, `/`-separated and relative. */
  path: string;
  bytes: Uint8Array;
}

/** How {@link zipStream} writes its entries. */
export interface ZipStreamOptions {
  /**
   * Whether to store `path` as it is rather than try to deflate it: for content that is usually
   * compressed already, such as images and documents, where deflating costs time and saves little.
   */
  store?: (path: string) => boolean;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const ZIP64_END_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;
/** The ZIP64 extra field carrying only a local header's offset: tag, size, and 8 bytes. */
const ZIP64_OFFSET_EXTRA_BYTES = 12;
const STORE = 0;
const DEFLATE = 8;
/** General-purpose flag bit 11: the entry name is UTF-8. */
const UTF8_FLAG = 0x0800;
/** 1980-01-01 00:00:00 in MS-DOS format, so the bytes never depend on the clock. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const MAX_ENTRIES = 0xffff;
const MAX_32 = 0xffffffff;

const encoder = new TextEncoder();

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes.slice()]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

/** One entry encoded at `offset`: its local header, name and data, and its central directory record. */
async function encodeEntry(entry: ZipWriteEntry, offset: number, store: boolean): Promise<{ local: Uint8Array[]; central: Uint8Array[]; length: number }> {
  const name = encoder.encode(entry.path);
  const deflated = store ? undefined : await deflateRaw(entry.bytes);
  const useDeflate = deflated !== undefined && deflated.byteLength < entry.bytes.byteLength;
  const data = useDeflate ? deflated : entry.bytes;
  if (data.byteLength >= MAX_32 || entry.bytes.byteLength >= MAX_32) throw new Error(`${entry.path} is too large for one ZIP entry`);
  // Only a local header's offset can need ZIP64; every entry is in memory, so far smaller than 4 GiB.
  const zip64 = offset >= MAX_32;
  const version = zip64 ? 45 : useDeflate ? 20 : 10;
  const crc = crc32(entry.bytes);

  const local = new DataView(new ArrayBuffer(LOCAL_HEADER_BYTES));
  local.setUint32(0, LOCAL_SIGNATURE, true);
  local.setUint16(4, useDeflate ? 20 : 10, true);
  local.setUint16(6, UTF8_FLAG, true);
  local.setUint16(8, useDeflate ? DEFLATE : STORE, true);
  local.setUint16(10, DOS_TIME, true);
  local.setUint16(12, DOS_DATE, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, data.byteLength, true);
  local.setUint32(22, entry.bytes.byteLength, true);
  local.setUint16(26, name.byteLength, true);

  const header = new DataView(new ArrayBuffer(CENTRAL_HEADER_BYTES));
  header.setUint32(0, CENTRAL_SIGNATURE, true);
  header.setUint16(4, zip64 ? 45 : 20, true);
  header.setUint16(6, version, true);
  header.setUint16(8, UTF8_FLAG, true);
  header.setUint16(10, useDeflate ? DEFLATE : STORE, true);
  header.setUint16(12, DOS_TIME, true);
  header.setUint16(14, DOS_DATE, true);
  header.setUint32(16, crc, true);
  header.setUint32(20, data.byteLength, true);
  header.setUint32(24, entry.bytes.byteLength, true);
  header.setUint16(28, name.byteLength, true);
  header.setUint16(30, zip64 ? ZIP64_OFFSET_EXTRA_BYTES : 0, true);
  // Comment, disk number and attributes are all zero.
  header.setUint32(42, zip64 ? MAX_32 : offset, true);
  const central = [new Uint8Array(header.buffer), name];
  if (zip64) {
    const extra = new DataView(new ArrayBuffer(ZIP64_OFFSET_EXTRA_BYTES));
    extra.setUint16(0, 0x0001, true);
    extra.setUint16(2, 8, true);
    extra.setBigUint64(4, BigInt(offset), true);
    central.push(new Uint8Array(extra.buffer));
  }
  return { local: [new Uint8Array(local.buffer), name, data], central, length: LOCAL_HEADER_BYTES + name.byteLength + data.byteLength };
}

/** The end records for `count` entries whose central directory is `size` bytes at `offset`. */
function endRecords(count: number, size: number, offset: number): Uint8Array[] {
  const zip64 = count >= MAX_ENTRIES || size >= MAX_32 || offset >= MAX_32;
  const end = new DataView(new ArrayBuffer(END_RECORD_BYTES));
  end.setUint32(0, END_SIGNATURE, true);
  end.setUint16(8, zip64 ? MAX_ENTRIES : count, true);
  end.setUint16(10, zip64 ? MAX_ENTRIES : count, true);
  end.setUint32(12, zip64 ? MAX_32 : size, true);
  end.setUint32(16, zip64 ? MAX_32 : offset, true);
  if (!zip64) return [new Uint8Array(end.buffer)];

  const record = new DataView(new ArrayBuffer(ZIP64_END_BYTES));
  record.setUint32(0, ZIP64_END_SIGNATURE, true);
  record.setBigUint64(4, BigInt(ZIP64_END_BYTES - 12), true);
  record.setUint16(12, 45, true);
  record.setUint16(14, 45, true);
  record.setBigUint64(24, BigInt(count), true);
  record.setBigUint64(32, BigInt(count), true);
  record.setBigUint64(40, BigInt(size), true);
  record.setBigUint64(48, BigInt(offset), true);
  const locator = new DataView(new ArrayBuffer(ZIP64_LOCATOR_BYTES));
  locator.setUint32(0, ZIP64_LOCATOR_SIGNATURE, true);
  locator.setBigUint64(8, BigInt(offset + size), true);
  locator.setUint32(16, 1, true);
  return [new Uint8Array(record.buffer), new Uint8Array(locator.buffer), new Uint8Array(end.buffer)];
}

/**
 * Writes `entries` as a ZIP, in the order given. The output depends on nothing but the entries:
 * every timestamp is the DOS epoch, and an entry is deflated only when that makes it smaller.
 *
 * @throws Error for more entries, or a larger archive, than a ZIP without ZIP64 holds.
 */
export async function writeZip(entries: readonly ZipWriteEntry[]): Promise<Uint8Array<ArrayBuffer>> {
  if (entries.length >= MAX_ENTRIES) throw new Error(`a ZIP holds at most ${MAX_ENTRIES - 1} entries without ZIP64`);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const encoded = await encodeEntry(entry, offset, false);
    parts.push(...encoded.local);
    central.push(...encoded.central);
    offset += encoded.length;
  }
  const centralBytes = central.reduce((n, part) => n + part.byteLength, 0);
  if (offset + centralBytes >= MAX_32) throw new Error("the archive is too large for a ZIP without ZIP64");
  const all = [...parts, ...central, ...endRecords(entries.length, centralBytes, offset)];
  const out = new Uint8Array(all.reduce((n, part) => n + part.byteLength, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * Writes `entries` as a ZIP stream, in the order given, pulling the next entry only when the reader
 * wants more: at most one entry's bytes are held at a time, plus the central directory (a few dozen
 * bytes an entry). Below ZIP64's thresholds the bytes are what {@link writeZip} writes for the same
 * entries and options. An error from `entries` errors the stream, so the reader never takes a
 * truncated archive for a whole one.
 */
export function zipStream(entries: AsyncIterable<ZipWriteEntry>, options: ZipStreamOptions = {}): ReadableStream<Uint8Array> {
  const iterator = entries[Symbol.asyncIterator]();
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) {
        const size = central.reduce((n, part) => n + part.byteLength, 0);
        for (const part of [...central, ...endRecords(count, size, offset)]) controller.enqueue(part);
        controller.close();
        return;
      }
      const encoded = await encodeEntry(next.value, offset, options.store?.(next.value.path) ?? false);
      for (const part of encoded.local) controller.enqueue(part);
      central.push(...encoded.central);
      offset += encoded.length;
      count += 1;
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  }, { highWaterMark: 0 });
}
