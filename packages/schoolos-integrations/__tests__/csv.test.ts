import { describe, expect, it } from "vitest";
import { oneroster } from "../src/index.ts";

const parse = (text: string, maxRows = 100) => oneroster.parseCsv(text, { maxRows });
const fields = (text: string) => {
  const result = parse(text);
  if (!result.ok) throw new Error(result.error.message);
  return result.records.map((r) => r.fields);
};

describe("parseCsv (RFC 4180)", () => {
  it("reads quoted fields holding commas, doubled quotes and line breaks", () => {
    expect(fields('a,b,c\r\n"x, y","say ""hi""","line one\r\nline two"\r\n')).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line one\r\nline two"],
    ]);
  });

  it("accepts CRLF and LF record endings, with or without a final line break", () => {
    expect(fields("a,b\r\n1,2\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("skips a leading byte order mark so the first header is not corrupted", () => {
    expect(fields("﻿sourcedId,name\r\n1,x\r\n")[0]).toEqual(["sourcedId", "name"]);
  });

  it("keeps empty fields, and an empty quoted field, but skips empty lines", () => {
    expect(fields('a,,c\r\n\r\n""\r\n,\r\n')).toEqual([["a", "", "c"], [""], ["", ""]]);
  });

  it("numbers rows by record and lines by position, which differ once a field spans lines", () => {
    const result = parse('h\r\n"one\ntwo"\r\nthree\r\n');
    expect(result.ok && result.records.map(({ row, line }) => [row, line])).toEqual([[1, 1], [2, 2], [3, 4]]);
  });

  it.each([
    ['a,b\r\n1,"open\r\n', "never closed", 2],
    ['a,b\r\n1,x"y\r\n', "quote inside an unquoted field", 2],
    ['a,b\r\n1,"x"y\r\n', "text after a closing quote", 2],
    ["a,b\r1,2\r\n", "carriage return", 1],
  ])("rejects malformed input %j", (text, message, row) => {
    const result = parse(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(message);
      expect(result.error.row).toBe(row);
    }
  });

  it("reports an unterminated quote at the line where it opened", () => {
    const result = parse('a\r\nb\r\n"never\r\nclosed\r\nat all');
    expect(!result.ok && result.error.line).toBe(3);
  });

  it("stops at the row cap instead of reading the whole file", () => {
    expect(parse("h\r\n1\r\n2\r\n", 2).ok).toBe(true);
    const result = parse("h\r\n1\r\n2\r\n3\r\n4\r\n", 2);
    expect(!result.ok && result.error).toEqual({ row: 4, line: 4, message: "has more than 2 data rows" });
  });
});
