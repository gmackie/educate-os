/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { docx, paragraph, pptx, onePagePdf } from "../../../../educateos-doc-extract/__tests__/documents.ts";
import { workbook } from "../../../../educateos-assessment-ci/__tests__/xlsx-fixture.ts";
import { courseCartridgePackage } from "../../../../educateos-cartridge/src/course.ts";
import { reviewTeacherFile } from "./reviewTeacherFile";
import { TeacherMaterialReview } from "./TeacherMaterialReview";
import "../../styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = undefined; container?.remove(); });

it.each([
  ["questions.csv", async () => new TextEncoder().encode('Question,Answer\n"Why plants?",Sunlight'), "Question,Answer\n\"Why plants?\",Sunlight"],
  ["questions.xlsx", () => workbook([{ name: "Teaching bank", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>Why plants?</t></is></c><c r="C1"><f>1+1</f><v>17</v></c></row>' }]), "Why plants?,,17"],
  ["lesson.docx", () => docx(paragraph("Ecosystem source")), "Ecosystem source"],
  ["lesson.pptx", () => pptx(["Second source", "First source"], [1, 0]), "Slide 1\nFirst source\n\nSlide 2\nSecond source"],
  ["lesson.pdf", () => onePagePdf("BT /F1 12 Tf (Readable PDF lesson) Tj ET", { compress: true }), "Readable PDF lesson"],
  ["course.imscc", () => courseCartridgePackage({ title: "Garden course", language: "en", modules: [{ title: "Unit", items: [{ kind: "page", title: "Lesson", body: "Garden course source" }] }] }), "Garden course source"],
] as const)("reads actual %s bytes in a browser worker", async (name, makeBytes, expected) => {
  const bytes = await makeBytes();
  const result = await reviewTeacherFile({ name, mimeType: "application/octet-stream", blob: new Blob([bytes.slice()]) }, new AbortController().signal);
  expect(result.status).toBe("reviewed");
  if (result.status !== "reviewed") throw new Error("Missing file review");
  expect(result.extraction.status).toBe("extracted");
  if (result.extraction.status !== "extracted") throw new Error("Missing source text");
  expect(result.extraction.text).toContain(expected);
});

it("includes course provenance and coverage in the browser preview", async () => {
  const bytes = await courseCartridgePackage({ title: "Garden course", language: "en", modules: [] });
  const result = await reviewTeacherFile({ name: "course.imscc", mimeType: "application/octet-stream", blob: new Blob([bytes.slice()]) }, new AbortController().signal);
  expect(result).toMatchObject({ extraction: { status: "extracted", text: expect.stringContaining("package sha256:") } });
  expect(result).toMatchObject({ extraction: { text: expect.stringContaining("No course, enrollment") } });
});

it("shows truncation and refuses malformed or unsupported files through the real worker", async () => {
  const file = (name: string, bytes: Uint8Array) => ({ name, mimeType: "application/octet-stream", blob: new Blob([bytes.slice()]) });
  expect(await reviewTeacherFile(file("partial.docx", await docx(paragraph("x".repeat(33_000)))), new AbortController().signal))
    .toMatchObject({ extraction: { status: "extracted", truncated: true } });
  expect(await reviewTeacherFile(file("backup.zip", new Uint8Array([1, 2])), new AbortController().signal))
    .toMatchObject({ extraction: { status: "not-extractable", reason: "malformed" } });
  expect(await reviewTeacherFile(file("lesson.ppt", new Uint8Array([1, 2])), new AbortController().signal))
    .toEqual({ status: "unsupported" });
});

it("opens the source preview by keyboard and renders source markup as plain text", async () => {
  const literal = '<script>window.sourceExecuted = true</script><img src="https://example.com/private">';
  const bytes = await docx(paragraph(literal.replaceAll("<", "&lt;").replaceAll(">", "&gt;")));
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<TeacherMaterialReview attachments={[{
    id: "file", name: "Teaching notes.docx", mimeType: "application/octet-stream", blob: new Blob([bytes.slice()]), uploadState: "ready",
  }]} />));
  const trigger = page.getByRole("button", { name: "Read extracted text from Teaching notes.docx" });
  await expect.element(trigger).toBeVisible();
  (await trigger.element()).focus();
  await act(async () => { await userEvent.keyboard("{Enter}"); });
  await expect.element(page.getByRole("button", { name: "Read extracted text from Teaching notes.docx" })).toHaveAttribute("aria-expanded", "true");
  const preview = page.getByLabelText("Extracted text from Teaching notes.docx");
  await expect.element(preview).toHaveTextContent(literal);
  expect(container.querySelector("pre script, pre img")).toBeNull();
});


it("shows real workbook omissions before the teacher sends and renders cell markup inertly", async () => {
  const bytes = await workbook([{ name: "Questions", rows: '<row r="1" hidden="1"><c r="A1" t="inlineStr"><is><t>&lt;img src="https://example.com/private"&gt;</t></is></c></row>' }]);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<TeacherMaterialReview attachments={[{
    id: "sheet", name: "questions.xlsx", mimeType: "application/octet-stream", blob: new Blob([bytes.slice()]), uploadState: "ready",
  }]} />));
  const trigger = page.getByRole("button", { name: "Read extracted text from questions.xlsx" });
  await expect.element(trigger).toBeVisible();
  await expect.element(page.getByText(/including hidden rows and columns/)).toBeVisible();
  await expect.element(page.getByText(/Formula values are cached and may be stale or missing/)).toBeVisible();
  await act(async () => { await userEvent.click(trigger); });
  await expect.element(page.getByLabelText("Extracted text from questions.xlsx")).toMatchTextContent('<img src=""https://example.com/private"">');
  expect(container.querySelector("pre img")).toBeNull();
});
