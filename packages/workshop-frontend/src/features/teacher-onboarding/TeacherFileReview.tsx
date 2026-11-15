import { useEffect, useState } from "react";
import { Button, Collapsible } from "@cloudflare/kumo";
import type { LessonSourceReview } from "@educateos/doc-extract/lesson-source";
import type { ComposerAttachment } from "../chat/composer/attachments/useComposerAttachments";
import { reviewTeacherFile } from "./reviewTeacherFile";

type ReviewState = { status: "reading" | "unavailable" } | LessonSourceReview;

const recovery = {
  "unsupported-encoding": "Some text encodings cannot be read. Export a text-based PDF or paste the relevant lesson text.",
  encrypted: "Use an unlocked copy, or paste the relevant lesson text.",
  "too-many-pages": "Share a smaller lesson with at most 100 pages or slides.",
  "too-large": "Share a smaller lesson export. Compressed contents can exceed the reading limit even when the upload fits.",
  "budget-exceeded": "This source is too complex for the local reader. Share a smaller lesson or paste the relevant text.",
  malformed: "This file could not be read in the expected format. Export a new PDF, DOCX, PPTX or Common Cartridge file, or paste the lesson text.",
  "no-text": "No readable text was found. A scan may need OCR; paste the text or export a text-based document.",
};

const omissions = {
  pdf: "Text preview only. Images, layout and some text encodings may be missing. A PDF-capable model may also read the original PDF after you send it.",
  docx: "Word body text only. Images, headers, footers, comments and embedded objects are omitted.",
  pptx: "Slide text in presentation order. Images, charts, speaker notes, animations and layout are omitted.",
  cartridge: "Read-only course preview. Check the coverage report for skipped, unplaced, flattened or shortened content. Linked pages have not been fetched.",
};

const reviewSummary = (review: ReviewState): string => {
  if (review.status === "reading") return "Checking readable text on this device…";
  if (review.status === "unavailable") return "Local preview unavailable. This does not mean the file is unreadable.";
  if (review.status === "unsupported") return "This local text preview does not support this file type.";
  if (review.extraction.status !== "extracted") return "No text preview available from this reader.";
  return review.extraction.truncated
    ? "Partial text preview — shortened to the lesson reading limit."
    : "Text preview ready — check the omissions below.";
};

/** A file's plain-text source check; this does not approve the material for student use. */
export const TeacherFileReview = ({ attachment }: { attachment: ComposerAttachment }) => {
  const [review, setReview] = useState<ReviewState>({ status: "reading" });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const { blob, mimeType, name } = attachment;

  useEffect(() => {
    const controller = new AbortController();
    setReview({ status: "reading" });
    reviewTeacherFile({ blob, mimeType, name }, controller.signal).then(
      result => { if (!controller.signal.aborted) setReview(result); },
      () => { if (!controller.signal.aborted) setReview({ status: "unavailable" }); },
    );
    return () => controller.abort();
  }, [blob, mimeType, name, attempt]);

  const extraction = review.status === "reviewed" ? review.extraction : undefined;
  const readable = extraction?.status === "extracted" ? extraction : undefined;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm">
      <h4 className="break-words font-medium text-kumo-default">{name || "Attached file"}</h4>
      <p role="status" className="text-kumo-subtle">{reviewSummary(review)}</p>
      {review.status === "reviewed" && (readable || review.type === "pdf") && <p className="text-kumo-subtle">{omissions[review.type]}</p>}
      {extraction?.status === "not-extractable" && <p className="text-kumo-subtle">{recovery[extraction.reason]}</p>}
      {review.status === "unsupported" && <p className="text-kumo-subtle">Use PDF, Word (.docx), PowerPoint (.pptx) or Common Cartridge (.imscc / supported .zip), or paste readable text. Other attachments may use the conversation’s existing readers. An ordinary ZIP or vendor backup is not a course import.</p>}
      {review.status === "unavailable" && <div className="flex flex-col items-start gap-2">
        <p className="text-kumo-subtle">Retry the check or share a readable excerpt. You can still send the original and ask the conversation to check coverage.</p>
        <Button type="button" size="sm" onClick={() => setAttempt(previous => previous + 1)}>Retry file check</Button>
      </div>}
      {readable && <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.DefaultTrigger>Read extracted text from {name || "attached file"}</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm text-kumo-default" tabIndex={0} aria-label={`Extracted text from ${name || "attached file"}`}>{readable.text}</pre>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>}
    </li>
  );
};
