import { z } from "zod";

/**
 * The content types the studio accepts. DOCX is detected so it can be stored and linked, but the
 * studio does not parse it: it yields no text for review.
 */
export const ContentType = z.enum(["pdf", "text", "html", "png", "jpeg", "docx"]);
/** An accepted content type. */
export type ContentType = z.infer<typeof ContentType>;

/** The media type each accepted content type is served and stored as. */
export const MEDIA_TYPES: Readonly<Record<ContentType, string>> = {
  pdf: "application/pdf",
  text: "text/plain",
  html: "text/html",
  png: "image/png",
  jpeg: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Media types a URL import may declare, and the content type each must turn out to be. */
const DECLARED_MEDIA_TYPES: Readonly<Record<string, ContentType>> = {
  ...Object.fromEntries(Object.entries(MEDIA_TYPES).map(([type, media]) => [media, type])),
  "application/xhtml+xml": "html",
};

/** The content type a declared media type (a `Content-Type` header or upload type) claims, if accepted. */
export function declaredContentType(mediaType: string): ContentType | undefined {
  return DECLARED_MEDIA_TYPES[mediaType.split(";")[0]!.trim().toLowerCase()];
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];

/**
 * The names of the entries in a ZIP archive, read from its local file headers. Stops at the first
 * byte that is not a local header, which is the central directory in a well-formed archive.
 */
function zipEntryNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && startsWith(bytes.subarray(offset), ZIP_LOCAL_HEADER)) {
    const flags = view.getUint16(offset + 6, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameEnd = offset + 30 + nameLength;
    if (nameEnd > bytes.length) break;
    names.push(new TextDecoder().decode(bytes.subarray(offset + 30, nameEnd)));
    // With a data descriptor (bit 3) the size is not in the header, so the next header cannot be found.
    if ((flags & 0x08) !== 0) break;
    offset = nameEnd + extraLength + compressedSize;
    if (names.length > 10_000) break;
  }
  return names;
}

/** Text that decodes as UTF-8 and holds no control characters other than whitespace. */
function decodeText(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // C0 controls other than tab, line feed, vertical tab, form feed and carriage return, and DEL.
    if ((code < 0x20 && (code < 0x09 || code > 0x0d)) || code === 0x7f) return undefined;
  }
  return text;
}

/**
 * The content type of `bytes`, decided by their content alone: never by a file name or a declared
 * media type, which the sender controls. Returns undefined for anything outside the allowlist,
 * including ZIP archives that are not Word documents and executables of every kind.
 */
export function sniffContentType(bytes: Uint8Array): ContentType | undefined {
  if (startsWith(bytes, PDF)) return "pdf";
  if (startsWith(bytes, PNG)) return "png";
  if (startsWith(bytes, JPEG)) return "jpeg";
  if (startsWith(bytes, ZIP_LOCAL_HEADER)) {
    const names = zipEntryNames(bytes);
    return names.includes("[Content_Types].xml") && names.includes("word/document.xml") ? "docx" : undefined;
  }
  const text = decodeText(bytes);
  if (text === undefined) return undefined;
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 1024).toLowerCase();
  return /^(<!doctype html|<html[\s>]|<head[\s>]|<!--)/.test(head) || /<(html|head|body)[\s>]/.test(head) ? "html" : "text";
}

const TEXTUAL: readonly ContentType[] = ["text", "html"];

/**
 * The content type to treat `bytes` as, given what the sender declared. Binary types must match
 * their magic bytes exactly. Text and HTML have no magic bytes, so between those two the declared
 * type wins: text declared as plain is never rendered as HTML.
 *
 * @returns the content type, or undefined when the bytes are outside the allowlist or contradict
 *   the declared type.
 */
export function resolveContentType(declared: ContentType, bytes: Uint8Array): ContentType | undefined {
  const sniffed = sniffContentType(bytes);
  if (sniffed === undefined) return undefined;
  if (TEXTUAL.includes(declared) && TEXTUAL.includes(sniffed)) return declared;
  return sniffed === declared ? sniffed : undefined;
}
