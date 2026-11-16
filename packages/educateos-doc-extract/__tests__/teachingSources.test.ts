import { courseCartridgePackage } from "@educateos/cartridge/course";
import { readZip, DEFAULT_ZIP_LIMITS } from "@educateos/cartridge/zip";
import { writeZip } from "@educateos/zip";
import { expect, it } from "vitest";
import { DEFAULT_EXTRACTION_LIMITS, extractDocumentText } from "../src/index.ts";
import { pptx } from "./documents.ts";

const encoder = new TextEncoder();
const repack = async (bytes: Uint8Array, edit: (files: Map<string, Uint8Array>) => void) => {
  const files = new Map((await readZip(bytes, DEFAULT_ZIP_LIMITS)).files);
  edit(files);
  return writeZip([...files].map(([path, bytes]) => ({ path, bytes: bytes.slice() })));
};

it("reads slide text in presentation order, omitting unplaced slides and speaker notes", async () => {
  expect(await extractDocumentText(await pptx(["Second & final", "First lesson", "UNPLACED"], [1, 0]), "pptx"))
    .toEqual({ status: "extracted", text: "Slide 1\nFirst lesson\n\nSlide 2\nSecond & final", truncated: false });
});

it("marks a partial slide excerpt and bounds pages, inflated size and parser work", async () => {
  const bytes = await pptx(["x".repeat(100), "OMITTED"]);
  const result = await extractDocumentText(bytes, "pptx", { ...DEFAULT_EXTRACTION_LIMITS, maxTextChars: 24 });
  expect(result).toMatchObject({ status: "extracted", truncated: true });
  expect(JSON.stringify(result)).not.toContain("OMITTED");
  for (const limits of [{ maxPages: 1 }, { maxInflatedBytes: 100 }, { maxSteps: 10 }]) {
    expect(await extractDocumentText(bytes, "pptx", { ...DEFAULT_EXTRACTION_LIMITS, ...limits }))
      .toMatchObject({ status: "not-extractable" });
  }
  expect(await extractDocumentText(await pptx([""]), "pptx")).toEqual({ status: "not-extractable", reason: "no-text" });
});

it.each(["https://example.com/slide.xml", "../slides/slide0.xml", "slides/missing.xml"])("refuses an invalid slide target %s", async target => {
  const bytes = await repack(await pptx(["Hidden"]), files => {
    const path = "ppt/_rels/presentation.xml.rels";
    files.set(path, encoder.encode(new TextDecoder().decode(files.get(path)).replace("slides/slide0.xml", target)));
  });
  expect(await extractDocumentText(bytes, "pptx")).toEqual({ status: "not-extractable", reason: "malformed" });
});

it("refuses DTDs in slides instead of resolving entities", async () => {
  const bytes = await repack(await pptx(["Hidden"]), files => files.set("ppt/slides/slide0.xml", encoder.encode('<!DOCTYPE x [<!ENTITY s SYSTEM "file:///private">]><x>&s;</x>')));
  expect(await extractDocumentText(bytes, "pptx")).toEqual({ status: "not-extractable", reason: "malformed" });
});

const course = () => courseCartridgePackage({ title: "Garden course", language: "en", modules: [{ title: "Ecosystems", items: [
  { kind: "page", title: "Field lesson", body: "Investigate food chains in the school garden." },
  { kind: "link", title: "Reading", url: "https://example.com/lesson" },
], discussions: [{ title: "Reflect", prompt: "How are the organisms connected?" }] }] });

it("previews course source text with provenance and coverage while reporting skipped content", async () => {
  const bytes = await repack(await course(), files => {
    const path = "imsmanifest.xml";
    files.set(path, encoder.encode(new TextDecoder().decode(files.get(path))
      .replace('type="webcontent"', 'type="vendor/unsupported"')));
  });
  const original = bytes.slice();
  const result = await extractDocumentText(bytes, "cartridge");
  expect(result.status).toBe("extracted");
  if (result.status !== "extracted") return;
  expect(result.text).toContain("package sha256:");
  expect(result.text).toContain("1 skipped placements");
  expect(result.text).toContain("unsupported-type");
  expect(result.text).toContain("How are the organisms connected?");
  expect(result.text).toContain("https://example.com/lesson");
  expect(result.text).not.toContain("Investigate food chains");
  expect(result.text).toContain("have not been fetched");
  expect(bytes).toEqual(original);
});

it("marks course preview truncation and refuses unrelated, excessive or malformed packages", async () => {
  expect(await extractDocumentText(await course(), "cartridge", { ...DEFAULT_EXTRACTION_LIMITS, maxTextChars: 512 }))
    .toMatchObject({ status: "extracted", truncated: true });
  expect(await extractDocumentText(await course(), "cartridge", { ...DEFAULT_EXTRACTION_LIMITS, maxSteps: 10 }))
    .toEqual({ status: "not-extractable", reason: "budget-exceeded" });
  const zip = await writeZip([{ path: "vendor-backup.json", bytes: encoder.encode("{}") }]);
  expect(await extractDocumentText(zip, "cartridge")).toEqual({ status: "not-extractable", reason: "malformed" });
  const oversized = await repack(await course(), files => files.set("large.txt", new Uint8Array(256 * 1024 + 1)));
  expect(await extractDocumentText(oversized, "cartridge")).toEqual({ status: "not-extractable", reason: "too-large" });
});

it("charges repeated placements before the course planner can multiply a small file into excessive work", async () => {
  const bytes = await repack(await courseCartridgePackage({ title: "Repeated", language: "en", modules: [{ title: "Unit", items: [
    { kind: "page", title: "Page", body: "x".repeat(1000) },
  ] }] }), files => {
    const path = "imsmanifest.xml";
    files.set(path, encoder.encode(new TextDecoder().decode(files.get(path)).replace('</organization>',
      `${Array.from({ length: 40 }, (_, i) => `<item identifier="repeat${i}" identifierref="R_1"><title>Again</title></item>`).join("")}</organization>`)));
  });
  expect(await extractDocumentText(bytes, "cartridge", { ...DEFAULT_EXTRACTION_LIMITS, maxSteps: 15_000 }))
    .toEqual({ status: "not-extractable", reason: "budget-exceeded" });
});
