// The XLSX converter: a workbook becomes the same canonical CSV every time, every cell type reads as
// written, and anything unsafe or unreadable is refused before it is used.
import { describe, expect, it } from "vitest";
import { xlsxToCsv } from "../src/index.ts";
import { workbook, zip } from "./xlsx-fixture.ts";

const LAB_ROWS = [
  `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>`,
  `<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>5.2</v></c><c r="C2"><v>30</v></c></row>`,
  `<row r="3"><c r="A3"><v>2</v></c><c r="B3"><v>5.0</v></c><c r="C3"><f>C2+1</f><v>31</v></c></row>`,
].join("");

describe("xlsxToCsv", () => {
  it("converts a sheet to canonical CSV, reading cached formula values and never evaluating", async () => {
    const bytes = await workbook([{ name: "Data", rows: LAB_ROWS }], ["Trial", "Mass (g)", "Time (s)"]);
    expect(await xlsxToCsv(bytes)).toBe("Trial,Mass (g),Time (s)\n1,5.2,30\n2,5,31");
    // Deflated parts read the same, and the same bytes always give the same text.
    const deflated = await workbook([{ name: "Data", rows: LAB_ROWS }], ["Trial", "Mass (g)", "Time (s)"], { deflate: true });
    expect(await xlsxToCsv(deflated)).toBe(await xlsxToCsv(bytes));
  });

  it("reads every cell type and keeps gaps as empty fields", async () => {
    const rows = [
      `<row r="1"><c r="A1" t="inlineStr"><is><r><t>Rich </t></r><r><t>text</t></r></is></c><c r="C1" t="b"><v>1</v></c></row>`,
      `<row r="3"><c r="B3" t="e"><v>#DIV/0!</v></c><c r="C3" t="str"><v>from a formula</v></c><c r="D3"><v>1E-3</v></c></row>`,
    ].join("");
    expect(await xlsxToCsv(await workbook([{ name: "S", rows }]))).toBe('Rich text,,TRUE,\n,,,\n,#DIV/0!,from a formula,0.001');
  });

  it("quotes only fields that need it", async () => {
    const rows = `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>`;
    const csv = await xlsxToCsv(await workbook([{ name: "S", rows }], ["plain", 'say "hi", twice', "two\nlines"]));
    expect(csv).toBe('plain,"say ""hi"", twice","two\nlines"');
  });

  it("chooses a sheet by name and refuses one the workbook does not have", async () => {
    const bytes = await workbook([{ name: "Notes", rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>notes</t></is></c></row>` }, { name: "Data", rows: `<row r="1"><c r="A1"><v>7</v></c></row>` }]);
    expect(await xlsxToCsv(bytes)).toBe("notes");
    expect(await xlsxToCsv(bytes, { sheet: "Data" })).toBe("7");
    await expect(xlsxToCsv(bytes, { sheet: "Answers" })).rejects.toMatchObject({ code: "validation-failed" });
  });

  it("refuses XML with a DTD, so no entity is ever expanded", async () => {
    const bytes = await zip([
      { path: "xl/workbook.xml", data: `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>` },
    ]);
    await expect(xlsxToCsv(bytes)).rejects.toThrow(/xml-doctype/);
  });

  it("refuses archives that break the limits before inflating them", async () => {
    // 1 MiB of zeros deflates far beyond the 100:1 ratio a workbook part may have.
    const bomb = await zip([{ path: "xl/workbook.xml", data: new Uint8Array(1024 * 1024), deflate: true }]);
    await expect(xlsxToCsv(bomb)).rejects.toThrow(/compression-ratio/);
    await expect(xlsxToCsv(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not-a-zip/);
    const traversal = await zip([{ path: "../xl/workbook.xml", data: "<workbook/>" }]);
    await expect(xlsxToCsv(traversal)).rejects.toThrow(/unsafe-path/);
  });

  it("refuses sheets past the row and column limits, and cells out of place", async () => {
    const wide = await workbook([{ name: "S", rows: `<row r="1"><c r="ZZ1"><v>1</v></c></row>` }]);
    const limits = { zip: { maxEntries: 50, maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22, maxCompressionRatio: 100 }, xml: { maxLength: 1 << 20, maxDepth: 16, maxElements: 10_000 }, maxRows: 10, maxColumns: 26 };
    await expect(xlsxToCsv(wide, { limits })).rejects.toThrow(/columns/);
    const tall = await workbook([{ name: "S", rows: `<row r="11"><c r="A11"><v>1</v></c></row>` }]);
    await expect(xlsxToCsv(tall, { limits })).rejects.toThrow(/rows/);
    const misplaced = await workbook([{ name: "S", rows: `<row r="1"><c r="A2"><v>1</v></c></row>` }]);
    await expect(xlsxToCsv(misplaced)).rejects.toThrow(/not in its row/);
    const missing = await workbook([{ name: "S", rows: `<row r="1"><c r="A1" t="s"><v>4</v></c></row>` }], ["only one"]);
    await expect(xlsxToCsv(missing)).rejects.toThrow(/shared string/);
  });
});
