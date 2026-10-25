// Builds small XLSX workbooks for tests: a ZIP of the parts a workbook needs, stored or deflated.
import { crc32 } from "@educateos/cartridge";

const encoder = new TextEncoder();

/** One ZIP entry: a path, its bytes, and whether to deflate them. */
export interface ZipEntry {
  path: string;
  data: Uint8Array | string;
  deflate?: boolean;
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A ZIP archive of `entries`, in order. */
export async function zip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : new Uint8Array(entry.data);
    const body = entry.deflate === true ? await deflateRaw(raw) : raw;
    const name = encoder.encode(entry.path);
    const crc = crc32(raw);
    const method = entry.deflate === true ? 8 : 0;
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A workbook whose sheets hold the given `<sheetData>` XML, with an optional shared string table. */
export async function workbook(sheets: { name: string; rows: string }[], sharedStrings?: string[], options: { deflate?: boolean } = {}): Promise<Uint8Array> {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    {
      path: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${RELS}"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      path: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${RELS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    },
    ...sheets.map((s, i) => ({
      path: `xl/worksheets/sheet${i + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><sheetData>${s.rows}</sheetData></worksheet>`,
      deflate: options.deflate === true,
    })),
  ];
  if (sharedStrings !== undefined) {
    entries.push({
      path: "xl/sharedStrings.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${MAIN}">${sharedStrings.map((t) => `<si><t xml:space="preserve">${escape(t)}</t></si>`).join("")}</sst>`,
    });
  }
  return zip(entries);
}
