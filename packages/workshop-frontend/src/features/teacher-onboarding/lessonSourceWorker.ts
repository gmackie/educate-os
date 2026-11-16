import { LESSON_SOURCE_LIMITS, lessonSourceType, reviewLessonSource, type LessonSourceFile } from "@educateos/doc-extract/lesson-source";

// Only local file bytes cross this worker boundary; it has no RPC or connector capabilities.
self.addEventListener("message", async (event: MessageEvent<LessonSourceFile & { blob: Blob }>) => {
  const { blob, ...file } = event.data;
  const type = lessonSourceType(file);
  const result = !type
    ? { status: "unsupported" as const }
    : blob.size > LESSON_SOURCE_LIMITS.maxBytes
      ? { status: "reviewed" as const, type, extraction: { status: "not-extractable" as const, reason: "too-large" as const } }
      : await reviewLessonSource(file, new Uint8Array(await blob.arrayBuffer()));
  // A dedicated worker's postMessage sends only to its owner; it has no targetOrigin parameter.
  // eslint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage(result);
});
