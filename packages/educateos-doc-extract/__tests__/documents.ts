// Builders for synthetic test documents. They write whatever they are told, so hostile documents
// can be built as easily as ordinary ones.
import { writeZip } from "@educateos/portability";

const encoder = new TextEncoder();
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** A DOCX whose body is `body` (WordprocessingML inside `<w:body>`), with optional extra entries. */
export async function docx(body: string, extra: { path: string; bytes: Uint8Array<ArrayBuffer> }[] = []): Promise<Uint8Array> {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
  return writeZip([
    { path: "[Content_Types].xml", bytes: encoder.encode("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>") },
    { path: "word/document.xml", bytes: encoder.encode(document) },
    ...extra,
  ]);
}

/** A paragraph of plain runs. */
export const paragraph = (...runs: string[]) => `<w:p>${runs.map((run) => `<w:r><w:t xml:space="preserve">${run}</w:t></w:r>`).join("")}</w:p>`;

/** zlib-compresses `bytes`, as a PDF's FlateDecode filter expects. */
export async function flate(bytes: Uint8Array | string): Promise<Uint8Array> {
  const input = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  const stream = new Blob([input.slice()]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One PDF object: a dictionary, and the stream data that follows it if any. */
export interface PdfObject {
  dictionary: string;
  stream?: Uint8Array | string;
}

const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** A PDF of `objects`, numbered from 1, with a trailer naming `trailer`. Offsets are not checked by the extractor. */
export function pdf(objects: readonly PdfObject[], trailer = "<< /Root 1 0 R >>"): Uint8Array {
  const parts: Uint8Array[] = [latin1("%PDF-1.7\n%âãÏÓ\n")];
  objects.forEach((object, index) => {
    if (object.stream === undefined) {
      parts.push(latin1(`${index + 1} 0 obj\n${object.dictionary}\nendobj\n`));
      return;
    }
    const data = typeof object.stream === "string" ? latin1(object.stream) : object.stream;
    const dictionary = object.dictionary.replace(/>>$/, ` /Length ${data.byteLength} >>`);
    parts.push(latin1(`${index + 1} 0 obj\n${dictionary}\nstream\n`), data, latin1("\nendstream\nendobj\n"));
  });
  parts.push(latin1(`trailer\n${trailer}\n%%EOF\n`));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** The catalog, page tree and `count` pages each drawing content object `content` (by number). */
export function pageTree(count: number, content: number): PdfObject[] {
  const kids = Array.from({ length: count }, (_, i) => `${i + 3} 0 R`).join(" ");
  return [
    { dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { dictionary: `<< /Type /Pages /Kids [${kids}] /Count ${count} >>` },
    ...Array.from({ length: count }, () => ({ dictionary: `<< /Type /Page /Parent 2 0 R /Contents ${content} 0 R >>` })),
  ];
}

/** A one-page PDF whose page draws `content`, optionally Flate-compressed. */
export async function onePagePdf(content: string, options: { compress?: boolean; trailer?: string } = {}): Promise<Uint8Array> {
  const stream = options.compress === true ? await flate(content) : content;
  return pdf([...pageTree(1, 4), { dictionary: options.compress === true ? "<< /Filter /FlateDecode >>" : "<< >>", stream }], options.trailer);
}
