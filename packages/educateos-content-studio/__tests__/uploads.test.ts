import { describe, expect, it, vi } from "vitest";
import { type MalwareScanner, resolveContentType, sniffContentType } from "../src/index.ts";
import { BIO_SCOPE, MORGAN, rejectsWith, studio } from "./helpers.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);

const PDF = text("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const EXE = bytes(0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0);
const ELF = bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0);

/** A stored (uncompressed) ZIP archive holding the named empty entries. */
function zip(...names: string[]): Uint8Array {
  const parts: number[] = [];
  for (const name of names) {
    const encoded = [...text(name)];
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(26, encoded.length, true);
    parts.push(...header, ...encoded);
  }
  parts.push(0x50, 0x4b, 0x01, 0x02); // central directory follows
  return Uint8Array.from(parts);
}

const MEDIA_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX = zip("[Content_Types].xml", "_rels/.rels", "word/document.xml");

const upload = (fileName: string, mediaType: string) => ({ fileName, mediaType, targetScope: BIO_SCOPE });

const clean: MalwareScanner = { scan: async () => ({ verdict: "clean" }) };

describe("content type detection by magic bytes", () => {
  it("detects each allowlisted type from its bytes", () => {
    expect(sniffContentType(PDF)).toBe("pdf");
    expect(sniffContentType(PNG)).toBe("png");
    expect(sniffContentType(JPEG)).toBe("jpeg");
    expect(sniffContentType(DOCX)).toBe("docx");
    expect(sniffContentType(text("Photosynthesis notes\n"))).toBe("text");
    expect(sniffContentType(text("﻿<!DOCTYPE html><html><body>x</body></html>"))).toBe("html");
  });

  it("refuses executables, non-Word archives and binary data", () => {
    expect(sniffContentType(EXE)).toBeUndefined();
    expect(sniffContentType(ELF)).toBeUndefined();
    expect(sniffContentType(zip("payload.exe"))).toBeUndefined();
    expect(sniffContentType(zip("[Content_Types].xml", "xl/workbook.xml"))).toBeUndefined();
    expect(sniffContentType(bytes(0xc3, 0x28, 0x00))).toBeUndefined();
  });

  it("refuses bytes that contradict the declared type", () => {
    expect(resolveContentType("pdf", PNG)).toBeUndefined();
    expect(resolveContentType("png", JPEG)).toBeUndefined();
    expect(resolveContentType("text", PDF)).toBeUndefined();
    expect(resolveContentType("docx", zip("payload.exe"))).toBeUndefined();
    // Text and HTML have no magic bytes; text declared as plain is never rendered as HTML.
    expect(resolveContentType("text", text("<html><body>x</body></html>"))).toBe("text");
  });
});

describe("uploads", () => {
  it("refuses an upload whose magic bytes do not match, whatever its file name says", async () => {
    const { studio: s, storage } = await studio({ scanner: clean });
    await rejectsWith(s.submitUpload(MORGAN, upload("worksheet.pdf", "application/pdf"), EXE), "policy-violation");
    await rejectsWith(s.submitUpload(MORGAN, upload("diagram.png", "image/png"), PDF), "policy-violation");
    await rejectsWith(s.submitUpload(MORGAN, upload("notes.txt", "text/plain"), ELF), "policy-violation");
    await rejectsWith(s.submitUpload(MORGAN, upload("lesson.docx", MEDIA_DOCX), zip("macro.bin")), "policy-violation");
    await rejectsWith(s.submitUpload(MORGAN, upload("page.svg", "image/svg+xml"), text("<svg/>")), "policy-violation");
    expect(await storage.listItems()).toStrictEqual([]);
  });

  it("takes the type from the bytes, not the file name", async () => {
    const { studio: s } = await studio({ scanner: clean });
    const item = await s.submitUpload(MORGAN, upload("diagram.exe", "image/png"), PNG);
    expect(item).toMatchObject({ contentType: "png", state: "reviewed", scan: { verdict: "clean" } });
  });

  it("stores a DOCX without parsing it", async () => {
    const { studio: s } = await studio({ scanner: clean });
    const item = await s.submitUpload(MORGAN, upload("lesson.docx", MEDIA_DOCX), DOCX);
    expect(item.contentType).toBe("docx");
    expect(item.checks?.flags.map((f) => f.code)).toContain("not-parsed");
  });

  it("enforces the size cap", async () => {
    const { studio: s } = await studio({ scanner: clean, maxUploadBytes: 16 });
    await rejectsWith(s.submitUpload(MORGAN, upload("notes.txt", "text/plain"), text("x".repeat(17))), "policy-violation");
  });

  it("refuses every upload while no scanner is configured, and stores nothing", async () => {
    const { studio: s, storage } = await studio({ scanner: undefined });
    await expect(s.submitUpload(MORGAN, upload("notes.txt", "text/plain"), text("notes"))).rejects.toMatchObject({ code: "unavailable", message: "scanner not configured" });
    expect(await storage.listItems()).toStrictEqual([]);
  });

  it("accepts unscanned uploads only when the district explicitly sets `none`, and records the skip", async () => {
    const { studio: s } = await studio({ scanner: "none" });
    const item = await s.submitUpload(MORGAN, upload("notes.txt", "text/plain"), text("Cell notes"));
    expect(item.scan).toStrictEqual({ verdict: "skipped" });
  });

  it("rejects an infected upload in quarantine without storing its bytes", async () => {
    const scanner: MalwareScanner = { scan: async () => ({ verdict: "infected", signature: "EICAR-Test-File" }) };
    const { studio: s, storage } = await studio({ scanner });
    const item = await s.submitUpload(MORGAN, upload("notes.txt", "text/plain"), text("X5O!P%@AP"));
    expect(item).toMatchObject({ state: "rejected", decision: { outcome: "rejected", by: "system" } });
    expect(await storage.getSnapshot(item.snapshotDigest)).toBeUndefined();
    expect(await s.listQueue(MORGAN, BIO_SCOPE)).toStrictEqual([]);
  });

  it("fails closed when the scanner throws or answers nonsense", async () => {
    const broken: MalwareScanner = { scan: vi.fn(async () => { throw new Error("scanner offline"); }) };
    const { studio: s } = await studio({ scanner: broken });
    await rejectsWith(s.submitUpload(MORGAN, upload("notes.txt", "text/plain"), text("notes")), "unavailable");

    const confused = { scan: async () => ({ verdict: "probably-fine" }) } as unknown as MalwareScanner;
    const { studio: s2 } = await studio({ scanner: confused });
    expect((await s2.submitUpload(MORGAN, upload("notes.txt", "text/plain"), text("notes"))).state).toBe("rejected");
  });
});
