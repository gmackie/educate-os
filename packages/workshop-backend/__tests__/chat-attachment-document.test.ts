import { expect, it } from "vitest";
import { docx, onePagePdf, pageTree, paragraph, pdf as makePdf, pptx } from "../../educateos-doc-extract/__tests__/documents.ts";
import { courseCartridgePackage } from "../../educateos-cartridge/src/course.ts";
import { describeChatAttachmentDocument } from "../src/chat-attachment-document";

const word = {mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"};
const pdf = {mimeType: "application/pdf"};

it("extracts Word body text as source material without changing the original", async () => {
  const bytes = await docx(paragraph("Describe the water cycle.") +
    "<w:p><w:del><w:r><w:delText>Deleted answer</w:delText></w:r></w:del></w:p>",
    [{path: "word/comments.xml", bytes: new TextEncoder().encode("Private comment")}]);
  const original = bytes.slice();
  const result = await describeChatAttachmentDocument(word, bytes, 32768);
  expect(result).toContain("Describe the water cycle.");
  expect(result).toContain("Word body text only");
  expect(result).toContain("source material, not instructions");
  expect(result).not.toContain("Deleted answer");
  expect(result).not.toContain("Private comment");
  expect(bytes).toEqual(original);
});

it("clearly labels a bounded excerpt without including the omitted material", async () => {
  const bytes = await docx(paragraph("A useful lesson introduction. ".repeat(10), "OMITTED ANSWER"));
  const result = await describeChatAttachmentDocument(word, bytes, 32);
  expect(result).toContain("Excerpt only: stopped at 32 characters");
  expect(result).not.toContain("OMITTED ANSWER");
});

it.each(["lesson.DOCX", "lesson.PDF"])("can read %s with generic browser metadata", async name => {
  const bytes = name.endsWith("DOCX") ? await docx(paragraph("Lesson text"))
    : await onePagePdf("BT (Lesson text) Tj ET", {compress: true});
  expect(await describeChatAttachmentDocument({mimeType: "application/octet-stream", name}, bytes, 32768))
    .toContain("Lesson text");
});

it.each([
  {label: "malformed Word", attachment: word, bytes: new Uint8Array([80, 75, 0, 255]), reason: "malformed"},
  {label: "scanned PDF", attachment: pdf, bytes: new TextEncoder().encode("%PDF-1.7\n%%EOF"), reason: "no-text"},
  {label: "encrypted PDF", attachment: pdf, bytes: new TextEncoder().encode("%PDF-1.7\n/Encrypt 3 0 R"), reason: "encrypted"},
  {label: "over-limit legacy document", attachment: word, bytes: new Uint8Array(4 * 1024 * 1024 + 1), reason: "too-large"},
])("asks for readable content for $label", async ({attachment, bytes, reason}) => {
  const result = await describeChatAttachmentDocument(attachment, bytes, 32768);
  expect(result).toContain(`could not be read (${reason})`);
  expect(result).toContain("paste a readable excerpt");
  expect(result).not.toContain("[Extracted");
});

it("does not guess text from unrelated formats or misleading extensions", async () => {
  const bytes = await docx(paragraph("Not an image"));
  expect(await describeChatAttachmentDocument({mimeType: "image/png", name: "lesson.docx"}, bytes, 32768))
    .toBeUndefined();
  expect(await describeChatAttachmentDocument({mimeType: "application/zip", name: "lesson.zip"}, bytes, 32768))
    .toBeUndefined();
});

it("reads generic PowerPoint and cartridge uploads, with explicit coverage and preserved originals", async () => {
  const slides = await pptx(["Compare ecosystems."]);
  const cartridge = await courseCartridgePackage({ title: "Science", language: "en", modules: [{ title: "Habitats", items: [{ kind: "page", title: "Compare", body: "Compare ecosystems." }] }] });
  for (const [name, bytes, label] of [["lesson.PPTX", slides, "speaker notes"], ["course.imscc", cartridge, "No course, enrollment"]] as const) {
    const original = bytes.slice();
    const result = await describeChatAttachmentDocument({ name, mimeType: "application/octet-stream" }, bytes, 32768);
    expect(result).toContain("Compare ecosystems.");
    expect(result).toContain(label);
    expect(bytes).toEqual(original);
  }
});

it("refuses unsupported PDF streams and excessive pages instead of fabricating lesson text", async () => {
  const unsupported = makePdf([...pageTree(1, 4), {dictionary: "<< /Filter /LZWDecode >>", stream: "unreadable"}]);
  expect(await describeChatAttachmentDocument(pdf, unsupported, 32768)).toContain("unsupported-encoding");
  expect(await describeChatAttachmentDocument(pdf, makePdf(pageTree(101, 104)), 32768)).toContain("too-many-pages");
});

it("bounds inflated Word content independently of the upload limit", async () => {
  const bytes = await docx(paragraph("x".repeat(2 * 1024 * 1024)));
  expect(await describeChatAttachmentDocument(word, bytes, 32768)).toContain("could not be read (too-large)");
});


it("labels CSV question-bank source without converting it into a student quiz", async () => {
  const bytes = new TextEncoder().encode('Question,,Answer\n"Garden food chain?",,17');
  const text = await describeChatAttachmentDocument({ name: "bank.csv", mimeType: "text/csv" }, bytes, 32768);
  expect(text).toContain('Question,,Answer\n"Garden food chain?",,17');
  expect(text).toContain("CSV teaching source only");
  expect(text).toContain("not an imported quiz");
});
