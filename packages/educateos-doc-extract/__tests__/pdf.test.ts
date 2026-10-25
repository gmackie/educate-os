import { describe, expect, it } from "vitest";
import { DEFAULT_EXTRACTION_LIMITS, extractDocumentText } from "../src/index.ts";
import { flate, onePagePdf, pageTree, pdf } from "./documents.ts";

const extract = (bytes: Uint8Array, limits = DEFAULT_EXTRACTION_LIMITS) => extractDocumentText(bytes, "pdf", limits);

describe("PDF extraction", () => {
  it("reads text shown in an uncompressed content stream", async () => {
    const bytes = await onePagePdf("BT /F1 12 Tf 72 720 Td (Cells are the unit of life.) Tj 0 -14 Td (The membrane \\(outer layer\\) controls entry.) Tj ET");
    expect(await extract(bytes)).toStrictEqual({ status: "extracted", text: "Cells are the unit of life.\nThe membrane (outer layer) controls entry.", truncated: false });
  });

  it("reads Flate-compressed streams, TJ arrays, octal escapes and UTF-16 strings", async () => {
    const content = "BT [(Photo)-20(synthesis)-500(uses)] TJ T* (caf\\351) Tj T* <FEFF0043006C006F00720061> Tj ET";
    expect(await extract(await onePagePdf(content, { compress: true }))).toStrictEqual({
      status: "extracted",
      text: "Photosynthesis uses\ncafé\nClora",
      truncated: false,
    });
  });

  it("ignores strings outside text objects and bytes inside other streams", async () => {
    const image = new TextEncoder().encode("9 0 obj << >> stream\nBT (FROM AN IMAGE) Tj ET\nendstream");
    const bytes = pdf([
      ...pageTree(1, 4),
      { dictionary: "<< >>", stream: "(NOT SHOWN) Tj BT (Shown) Tj ET" },
      { dictionary: "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 >>", stream: image },
    ]);
    expect(await extract(bytes)).toStrictEqual({ status: "extracted", text: "Shown", truncated: false });
  });

  it("refuses text behind filters it does not decode rather than guessing", async () => {
    const bytes = pdf([...pageTree(1, 4), { dictionary: "<< /Filter /LZWDecode >>", stream: "\u0080\u000b`P" }]);
    expect(await extract(bytes)).toStrictEqual({ status: "not-extractable", reason: "unsupported-encoding" });
    const chained = pdf([...pageTree(1, 4), { dictionary: "<< /Filter [/ASCII85Decode /FlateDecode] >>", stream: "GhVOJ~>" }]);
    expect(await extract(chained)).toStrictEqual({ status: "not-extractable", reason: "unsupported-encoding" });
  });

  it("refuses text drawn through a font's own glyph encoding", async () => {
    // Identity-H: two-byte glyph IDs, which read as control codes and stray Latin-1.
    const bytes = await onePagePdf("BT <0024004B0048000300480051004700030052004900030057004B0048> Tj ET");
    expect(await extract(bytes)).toStrictEqual({ status: "not-extractable", reason: "unsupported-encoding" });
  });

  it("reports a scanned page with no text operators as having no text", async () => {
    expect(await extract(await onePagePdf("q 612 0 0 792 0 0 cm /Im1 Do Q"))).toStrictEqual({ status: "not-extractable", reason: "no-text" });
  });

  it("refuses encrypted documents", async () => {
    const bytes = await onePagePdf("BT (secret) Tj ET", { trailer: "<< /Root 1 0 R /Encrypt 9 0 R >>" });
    expect(await extract(bytes)).toStrictEqual({ status: "not-extractable", reason: "encrypted" });
  });

  it("refuses more pages than the cap, counting pages packed in object streams", async () => {
    const limits = { ...DEFAULT_EXTRACTION_LIMITS, maxPages: 3 };
    const many = pdf([...pageTree(4, 7), { dictionary: "<< >>", stream: "BT (x) Tj ET" }]);
    expect(await extract(many, limits)).toStrictEqual({ status: "not-extractable", reason: "too-many-pages" });

    const packed = await flate("3 0 4 40 5 80 6 120 << /Type /Page >> << /Type /Page >> << /Type /Page >> << /Type /Page >>");
    const hidden = pdf([
      { dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
      { dictionary: "<< /Type /Pages /Count 4 >>" },
      { dictionary: "<< /Type /ObjStm /N 4 /First 16 /Filter /FlateDecode >>", stream: packed },
      { dictionary: "<< >>", stream: "BT (x) Tj ET" },
    ]);
    expect(await extract(hidden, limits)).toStrictEqual({ status: "not-extractable", reason: "too-many-pages" });
  });

  it("stops inflating a decompression bomb at the cap", async () => {
    const bomb = await flate(new Uint8Array(8 * 1024 * 1024));
    const bytes = pdf([...pageTree(1, 4), { dictionary: "<< /Filter /FlateDecode >>", stream: bomb }]);
    expect(await extract(bytes, { ...DEFAULT_EXTRACTION_LIMITS, maxInflatedBytes: 1024 * 1024 })).toStrictEqual({ status: "not-extractable", reason: "too-large" });
  });

  it("stops at the step budget", async () => {
    const content = `BT ${Array.from({ length: 5000 }, (_, i) => `(word${i}) Tj`).join(" ")} ET`;
    expect(await extract(await onePagePdf(content), { ...DEFAULT_EXTRACTION_LIMITS, maxSteps: 10_000 })).toStrictEqual({ status: "not-extractable", reason: "budget-exceeded" });
  });

  it("refuses a document over the size cap before reading it, and anything that is not a PDF", async () => {
    const bytes = await onePagePdf("BT (x) Tj ET");
    expect(await extract(bytes, { ...DEFAULT_EXTRACTION_LIMITS, maxBytes: 10 })).toStrictEqual({ status: "not-extractable", reason: "too-large" });
    expect(await extract(new TextEncoder().encode("<html>not a pdf</html>"))).toStrictEqual({ status: "not-extractable", reason: "malformed" });
  });

  it("survives truncated and unterminated structures", async () => {
    const bytes = await onePagePdf("BT (unterminated Tj ET");
    const cut = bytes.subarray(0, bytes.byteLength - 40);
    for (const sample of [bytes, cut]) {
      const result = await extract(sample);
      expect(["extracted", "not-extractable"]).toContain(result.status);
    }
  });
});
