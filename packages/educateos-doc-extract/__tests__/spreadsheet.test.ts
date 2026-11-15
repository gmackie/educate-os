import { expect, it } from "vitest";
import { extractDocumentText } from "../src/index.ts";
import { LESSON_SOURCE_LIMITS, lessonSourceType, reviewLessonSource } from "../src/lesson-source.ts";
import { workbook } from "../../educateos-assessment-ci/__tests__/xlsx-fixture.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const read = (text: string) => extractDocumentText(encode(text), "csv", LESSON_SOURCE_LIMITS);

it("preserves UTF-8/BOM headers, empty columns, multiline cells and formula-like teaching text", async () => {
  const text = '\uFEFFQuestion,Answer,Notes\r\n"Why café, plants?",,"Line one\nLine two"\r\n=HYPERLINK(""bad""),A,teacher';
  // Formula-like cell text follows the same strict CSV quoting rules as any other text.
  const valid = text.replace('=HYPERLINK(""bad""),', '"=HYPERLINK(""bad"")",');
  const result = await read(valid);
  expect(result).toMatchObject({ status: "extracted", text: expect.stringContaining('Question,Answer,Notes\r\n"Why café, plants?",,"Line one\nLine two"'), truncated: false });
  expect(result).toMatchObject({ text: expect.stringContaining('"=HYPERLINK(""bad"")"') });
});

it.each(['a,b\n"unclosed', 'a,b\n"quoted"junk,x', 'a,b\r1,2'])("refuses malformed CSV %j", async text => {
  expect(await read(text)).toEqual({ status: "not-extractable", reason: "malformed" });
});

it("refuses unsupported binary/UTF-16 encodings, empty data, wide/tall tables and exhausted work", async () => {
  expect(await extractDocumentText(new Uint8Array([255, 254, 65, 0]), "csv", LESSON_SOURCE_LIMITS)).toMatchObject({ reason: "unsupported-encoding" });
  expect(await read("a\0,b")).toMatchObject({ reason: "unsupported-encoding" });
  expect(await read("\n,\n")).toMatchObject({ reason: "no-text" });
  expect(await read(Array(101).fill("c").join(","))).toMatchObject({ reason: "too-large" });
  expect(await read(Array(1001).fill("r").join("\n"))).toMatchObject({ reason: "too-large" });
  expect(await extractDocumentText(encode("a,b\n1,2"), "csv", { ...LESSON_SOURCE_LIMITS, maxSteps: 3 })).toMatchObject({ reason: "budget-exceeded" });
});

it("reads only the first worksheet, preserving sparse columns and cached formula values", async () => {
  const bytes = await workbook([
    { name: "Questions", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>Question</t></is></c><c r="C1" t="s"><v>0</v></c></row><row r="2" hidden="1"><c r="A2" t="b"><v>1</v></c><c r="C2"><f>1+1</f><v>17</v></c></row>' },
    { name: "Other sheet", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>OMITTED SOURCE</t></is></c></row>' },
  ], ["Answer"], { deflate: true });
  const original = bytes.slice();
  const result = await extractDocumentText(bytes, "xlsx", LESSON_SOURCE_LIMITS);
  expect(result).toMatchObject({ status: "extracted", text: expect.stringContaining('First worksheet "Questions" only') });
  expect(result).toMatchObject({ text: expect.stringContaining("Question,,Answer\nTRUE,,17") });
  if (result.status !== "extracted") throw new Error("Missing text");
  expect(result.text).not.toContain("OMITTED SOURCE");
  expect(result.text).not.toContain("1+1");
  expect(bytes).toEqual(original);
});

it("caps CSV and XLSX output with a truthful excerpt flag", async () => {
  const csv = encode('Question,Answer\n' + 'x'.repeat(200));
  const xlsx = await workbook([{ name: "Data", rows: `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` }], ["x".repeat(200)]);
  for (const [bytes, type] of [[csv, "csv"], [xlsx, "xlsx"]] as const) {
    const result = await extractDocumentText(bytes, type, { ...LESSON_SOURCE_LIMITS, maxTextChars: 128 });
    expect(result).toMatchObject({ status: "extracted", truncated: true });
    if (result.status !== "extracted") throw new Error("Missing excerpt");
    expect(result.text.length).toBe(128);
  }
});

it("refuses an empty first sheet without substituting later sheets, and enforces lesson table limits", async () => {
  const later = { name: "Later", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>Do not substitute</t></is></c></row>' };
  const empty = await workbook([{ name: "Empty", rows: "" }, later]);
  expect(await extractDocumentText(empty, "xlsx", LESSON_SOURCE_LIMITS)).toEqual({ status: "not-extractable", reason: "no-text" });
  for (const [row, column] of [[1001, "A"], [1, "CW"]] as const) {
    const bytes = await workbook([{ name: "Oversized", rows: `<row r="${row}"><c r="${column}${row}"><v>1</v></c></row>` }]);
    expect(await extractDocumentText(bytes, "xlsx", LESSON_SOURCE_LIMITS)).toEqual({ status: "not-extractable", reason: "too-large" });
  }
});

it("uses spreadsheet extensions only with compatible metadata, checks bytes and preserves unsupported formats", async () => {
  for (const mimeType of ["text/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"]) {
    expect(lessonSourceType({ name: "BANK.CSV", mimeType })).toBe("csv");
  }
  expect(lessonSourceType({ name: "bank.xlsx", mimeType: "application/octet-stream" })).toBe("xlsx");
  expect(lessonSourceType({ name: "bank.csv", mimeType: "image/png" })).toBeUndefined();
  expect(lessonSourceType({ name: "bank.xlsm", mimeType: "application/octet-stream" })).toBeUndefined();
  expect(await reviewLessonSource({ name: "bank.xlsx", mimeType: "application/octet-stream" }, encode("Not a workbook"))).toMatchObject({ extraction: { reason: "malformed" } });
});
