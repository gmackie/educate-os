// The XLSX converter: a workbook becomes the same canonical CSV every time, every cell type reads as
// written, and anything unsafe or unreadable is refused before it is used.
import { describe, expect, it } from "vitest";
import { readXlsxWorkbook, readXlsxWorksheet, xlsxToCsv } from "../src/index.ts";
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

  it("does not invent values for formulas without a cache, including shared-string cells", async () => {
    const rows = '<row r="1"><c r="A1" t="s"><f>A2</f></c><c r="B1"><f>B2</f></c><c r="C1" t="str"><f>C2</f></c><c r="D1"><v>7</v></c></row>';
    expect(await xlsxToCsv(await workbook([{ name: "S", rows }], ["Not a cached answer"]))).toBe(",,,7");
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


it("bounds a repeated shared-string projection and identifies the chosen sheet", async () => {
  const bytes = await workbook([{ name: "Teaching data", rows: `<row r="1">${["A", "B", "C"].map(c => `<c r="${c}1" t="s"><v>0</v></c>`).join("")}</row>` }], ["x".repeat(1000)]);
  expect(await readXlsxWorksheet(bytes, { maxTextChars: 25 })).toEqual({ sheetName: "Teaching data", csv: "x".repeat(25), truncated: true });
  let remaining = 20;
  await expect(readXlsxWorksheet(bytes, { maxTextChars: 25, spend: n => { remaining -= n; if (remaining < 0) throw new Error("budget"); } })).rejects.toThrow("budget");
});

it("refuses external worksheet relationships rather than following or misreading them", async () => {
  const bytes = await zip([
    { path: "xl/workbook.xml", data: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="External" r:id="r1"/></sheets></workbook>` },
    { path: "xl/_rels/workbook.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="https://example.com/private" TargetMode="External"/></Relationships>` },
  ]);
  await expect(readXlsxWorksheet(bytes, { maxTextChars: 50 })).rejects.toThrow("external or unsupported");
});

it("reads workbook order with hidden/empty sheets under a shared CSV cap while keeping assessment selection", async () => {
  const bytes = await workbook([
    { name: "Cover", rows: "" },
    { name: "Data", rows: LAB_ROWS },
    { name: "Teacher notes", state: "hidden", rows: '<row r="1"><c r="A1"><v>42</v></c></row>' },
  ], ["Trial", "Mass (g)", "Time (s)"]);
  const options = { maxTextChars: 1000, maxSheets: 100, maxTotalRows: 1000 };
  expect(await readXlsxWorkbook(bytes, options)).toEqual({ truncated: false, worksheets: [
    { sheetName: "Cover", visibility: "visible", source: { csv: "", truncated: false } },
    { sheetName: "Data", visibility: "visible", source: { csv: "Trial,Mass (g),Time (s)\n1,5.2,30\n2,5,31", truncated: false } },
    { sheetName: "Teacher notes", visibility: "hidden", source: { csv: "42", truncated: false } },
  ] });
  const bounded = await readXlsxWorkbook(bytes, { ...options, maxTextChars: 5 });
  expect(bounded).toMatchObject({ truncated: true, worksheets: [
    { source: { csv: "" } }, { source: { csv: "Trial", truncated: true } }, { sheetName: "Teacher notes" },
  ] });
  expect(bounded.worksheets[2]?.source).toBeUndefined();
  expect(await xlsxToCsv(bytes)).toBe("");
  expect(await xlsxToCsv(bytes, { sheet: "Teacher notes" })).toBe("42");
});

it("refuses ambiguous workbook names and aggregate row overflow", async () => {
  const options = { maxTextChars: 1000, maxSheets: 100, maxTotalRows: 3 };
  const duplicate = await workbook([{ name: "Same", rows: "" }, { name: "Same", rows: "" }]);
  await expect(readXlsxWorkbook(duplicate, options)).rejects.toThrow("ambiguous");
  const rows = '<row r="2"><c r="A2"><v>1</v></c></row>';
  await expect(readXlsxWorkbook(await workbook([{ name: "A", rows }, { name: "B", rows }]), options)).rejects.toMatchObject({ reason: "too-large" });
});

it("checks later worksheet relationships even when the excerpt has no remaining space", async () => {
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const bytes = await zip([
    { path: "xl/workbook.xml", data: `<workbook xmlns="${main}" xmlns:r="${rels}"><sheets><sheet name="Safe" r:id="r1"/><sheet name="External" r:id="r2"/></sheets></workbook>` },
    { path: "xl/_rels/workbook.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${rels}/worksheet" Target="worksheets/safe.xml"/><Relationship Id="r2" Type="${rels}/worksheet" Target="https://example.test/private" TargetMode="External"/></Relationships>` },
    { path: "xl/worksheets/safe.xml", data: `<worksheet xmlns="${main}"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>` },
  ]);
  await expect(readXlsxWorkbook(bytes, { maxTextChars: 1, maxSheets: 100, maxTotalRows: 1000 })).rejects.toThrow("external or unsupported");
  // A consumer explicitly selecting one worksheet retains its existing assessment behavior.
  expect(await xlsxToCsv(bytes)).toBe("42");
});
