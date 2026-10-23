// A deterministic ZIP writer (SCHO-186), for the packages SchoolOS produces, such as a course's
// Common Cartridge export. It writes the subset the bounded reader (`readZip`) accepts: one disk,
// no ZIP64, no encryption, no data descriptors, no extra fields, store or raw deflate. Derived from
// the `.schoolos` archive writer in `@schoolos/portability`, which can move onto this one.
import { crc32 } from "./zip.ts";

/** One file to write. */
export interface ZipWriteEntry {
  /** The entry's path, `/`-separated and relative. */
  path: string;
  bytes: Uint8Array;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const STORE = 0;
const DEFLATE = 8;
/** General-purpose flag bit 11: the entry name is UTF-8. */
const UTF8_FLAG = 0x0800;
/** 1980-01-01 00:00:00 in MS-DOS format, so the bytes never depend on the clock. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const MAX_ENTRIES = 0xffff;

const encoder = new TextEncoder();

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes.slice()]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

/**
 * Writes `entries` as a ZIP, in the order given. The output depends on nothing but the entries:
 * every timestamp is the DOS epoch, and an entry is deflated only when that makes it smaller.
 *
 * @throws Error for more entries, or a larger archive, than a ZIP without ZIP64 holds.
 */
export async function writeZip(entries: readonly ZipWriteEntry[]): Promise<Uint8Array<ArrayBuffer>> {
  if (entries.length > MAX_ENTRIES) throw new Error(`a ZIP holds at most ${MAX_ENTRIES} entries without ZIP64`);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const deflated = await deflateRaw(entry.bytes);
    const useDeflate = deflated.byteLength < entry.bytes.byteLength;
    const data = useDeflate ? deflated : entry.bytes;
    const version = useDeflate ? 20 : 10;
    const crc = crc32(entry.bytes);

    const local = new DataView(new ArrayBuffer(LOCAL_HEADER_BYTES));
    local.setUint32(0, LOCAL_SIGNATURE, true);
    local.setUint16(4, version, true);
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
    header.setUint16(4, 20, true);
    header.setUint16(6, version, true);
    header.setUint16(8, UTF8_FLAG, true);
    header.setUint16(10, useDeflate ? DEFLATE : STORE, true);
    header.setUint16(12, DOS_TIME, true);
    header.setUint16(14, DOS_DATE, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, data.byteLength, true);
    header.setUint32(24, entry.bytes.byteLength, true);
    header.setUint16(28, name.byteLength, true);
    // Extra field, comment, disk number and attributes are all zero.
    header.setUint32(42, offset, true);

    parts.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(header.buffer), name);
    offset += LOCAL_HEADER_BYTES + name.byteLength + data.byteLength;
  }
  const centralBytes = central.reduce((n, part) => n + part.byteLength, 0);
  if (offset + centralBytes > 0xffffffff) throw new Error("the archive is too large for a ZIP without ZIP64");
  const end = new DataView(new ArrayBuffer(END_RECORD_BYTES));
  end.setUint32(0, END_SIGNATURE, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralBytes, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, part) => n + part.byteLength, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
