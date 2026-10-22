import { describe, expect, it } from "vitest";
import { extractForReview, MAX_EXTRACTED_TEXT, type TextExtractor } from "../src/index.ts";

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

const throwing: TextExtractor = async () => {
  throw new Error("parser fault");
};
const long: TextExtractor = async () => ({ status: "extracted", text: "x".repeat(MAX_EXTRACTED_TEXT + 10), truncated: false });

describe("extractForReview", () => {
  it("treats a failing or misbehaving extractor as a malformed document, never as text", async () => {
    const wrongShape = (async () => ({ status: "extracted", text: 42 })) as unknown as TextExtractor;
    const unknownReason = (async () => ({ status: "not-extractable", reason: "something-new" })) as unknown as TextExtractor;
    for (const extractor of [throwing, wrongShape, unknownReason]) {
      expect(await extractForReview(extractor, bytes, "pdf")).toStrictEqual({ record: { status: "not-extractable", reason: "malformed" }, text: undefined });
    }
  });

  it("caps the text kept for review whatever the extractor returns", async () => {
    const { record, text } = await extractForReview(long, bytes, "pdf");
    expect(record).toStrictEqual({ status: "extracted", characters: MAX_EXTRACTED_TEXT, truncated: true });
    expect(text).toHaveLength(MAX_EXTRACTED_TEXT);
  });

  it("records that no extractor is configured", async () => {
    expect(await extractForReview(undefined, bytes, "docx")).toStrictEqual({ record: { status: "not-configured" }, text: undefined });
  });
});
