// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LessonSourceReview } from "@educateos/doc-extract/lesson-source";
import type { ComposerAttachment } from "../chat/composer/attachments/useComposerAttachments";
import { reviewTeacherFile } from "./reviewTeacherFile";
import { TeacherMaterialReview } from "./TeacherMaterialReview";

vi.mock("./reviewTeacherFile", () => ({ reviewTeacherFile: vi.fn<typeof reviewTeacherFile>() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
const attachment: ComposerAttachment = { id: "source", blob: new Blob(["lesson"]), mimeType: "application/octet-stream", name: "Lesson.docx", uploadState: "ready" };
const preview = (text = "Reviewed lesson"): LessonSourceReview => ({ status: "reviewed", type: "docx", extraction: { status: "extracted", text, truncated: false } });
const render = async (attachments = [attachment]) => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<TeacherMaterialReview attachments={attachments} />));
};

afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.resetAllMocks(); });

it("does not turn local readability into a publication or connected-source claim", async () => {
  vi.mocked(reviewTeacherFile).mockResolvedValue(preview());
  await render();
  expect(container.textContent).toContain("Text preview ready");
  expect(container.textContent).toContain("headers, footers, comments");
  expect(container.textContent).toContain("no lesson is published");
  expect(container.textContent).toContain("does not read their contents");
});

it("cancels removed files and ignores their late results", async () => {
  let complete!: (value: LessonSourceReview) => void;
  vi.mocked(reviewTeacherFile).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await render();
  const signal = vi.mocked(reviewTeacherFile).mock.calls[0][1];
  await act(async () => root!.render(<TeacherMaterialReview attachments={[]} />));
  expect(signal.aborted).toBe(true);
  await act(async () => complete(preview("STALE SOURCE")));
  expect(container.textContent).toBe("");
});

it("recovers from a blocked worker with an explicit retry", async () => {
  vi.mocked(reviewTeacherFile).mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce(preview());
  await render();
  expect(container.textContent).toContain("Local preview unavailable");
  expect(container.textContent).not.toContain("blocked");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.textContent).toContain("Text preview ready");
});

it.each([
  ["encrypted", "unlocked copy"], ["no-text", "OCR"], ["too-many-pages", "100 pages or slides"],
  ["too-large", "Compressed contents"], ["budget-exceeded", "too complex"],
  ["malformed", "expected format"], ["unsupported-encoding", "text encodings"],
] as const)("gives recovery guidance for %s", async (reason, message) => {
  vi.mocked(reviewTeacherFile).mockResolvedValue({ status: "reviewed", type: "docx", extraction: { status: "not-extractable", reason } });
  await render();
  expect(container.textContent).toContain(message);
  expect(container.textContent).not.toContain("Text preview ready");
});

it("does not label an unsupported attachment as imported", async () => {
  vi.mocked(reviewTeacherFile).mockResolvedValue({ status: "unsupported" });
  await render();
  expect(container.textContent).toContain("does not support this file type");
  expect(container.textContent).toContain("ordinary ZIP or vendor backup is not a course import");
});
