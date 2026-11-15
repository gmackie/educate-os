import { expect, it } from "vitest";
import { LESSON_SOURCE_LIMITS, lessonSourceType, reviewLessonSource } from "../src/lesson-source.ts";
import { docx, paragraph } from "./documents.ts";

it("uses extensions only for generic MIME types, and never treats every ZIP as a known course", async () => {
  expect(lessonSourceType({ mimeType: "application/octet-stream", name: "LESSON.PPTX" })).toBe("pptx");
  expect(lessonSourceType({ mimeType: "image/png", name: "lesson.docx" })).toBeUndefined();
  expect(lessonSourceType({ mimeType: "application/zip", name: "course.imscc" })).toBe("cartridge");
  expect(await reviewLessonSource({ mimeType: "application/zip", name: "backup.zip" }, new Uint8Array([1, 2])))
    .toMatchObject({ status: "reviewed", type: "cartridge", extraction: { status: "not-extractable", reason: "malformed" } });
});

it("checks actual bytes and reports an excerpt using the shared replay limits", async () => {
  const file = { mimeType: "application/octet-stream", name: "lesson.docx" };
  const bytes = await docx(paragraph("x".repeat(LESSON_SOURCE_LIMITS.maxTextChars + 100)));
  const original = bytes.slice();
  expect(await reviewLessonSource(file, bytes)).toMatchObject({
    status: "reviewed", type: "docx", extraction: { status: "extracted", text: "x".repeat(LESSON_SOURCE_LIMITS.maxTextChars), truncated: true },
  });
  expect(bytes).toEqual(original);
  expect(await reviewLessonSource(file, new Uint8Array(LESSON_SOURCE_LIMITS.maxBytes + 1)))
    .toMatchObject({ extraction: { status: "not-extractable", reason: "too-large" } });
});
