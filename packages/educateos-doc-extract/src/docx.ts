import { CartridgeRefusedError, parseXml, readZip, type XmlElement, type XmlNode } from "@educateos/cartridge";
import { type StepBudget, ExtractionStopped, TextSink } from "./budget.ts";
import type { ExtractionLimits } from "./limits.ts";

/** The WordprocessingML namespace every body element is in. */
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DOCUMENT = "word/document.xml";

/** Archive refusals that mean "too big" rather than "broken". */
const SIZE_REFUSALS = new Set(["too-many-entries", "entry-too-large", "package-too-large", "compression-ratio"]);

/**
 * Extracts the body text of a DOCX: the bounded unzip and DTD-free XML parser the cartridge
 * importer uses, then the text runs (`w:t`), tabs and breaks of `word/document.xml`, a line per
 * paragraph. Deleted revisions and field codes are left out. Headers, footers, comments and
 * embedded objects are not read.
 *
 * @throws ExtractionStopped with the reason it could not be read.
 */
export async function extractDocxText(bytes: Uint8Array, limits: ExtractionLimits, budget: StepBudget): Promise<{ text: string; truncated: boolean }> {
  let files: ReadonlyMap<string, Uint8Array>;
  try {
    ({ files } = await readZip(bytes, {
      maxEntries: 2000,
      maxEntryBytes: Math.min(limits.maxInflatedBytes, 32 * 1024 * 1024),
      maxTotalBytes: limits.maxInflatedBytes,
      maxCompressionRatio: 100,
    }));
  } catch (error) {
    if (error instanceof CartridgeRefusedError) throw new ExtractionStopped(SIZE_REFUSALS.has(error.reason) ? "too-large" : "malformed");
    throw error;
  }
  const document = files.get(DOCUMENT);
  if (document === undefined) throw new ExtractionStopped("malformed");
  budget.spend(document.byteLength);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(document);
  } catch {
    throw new ExtractionStopped("malformed");
  }
  let root;
  try {
    root = parseXml(source, { maxLength: limits.maxInflatedBytes, maxDepth: 256, maxElements: 2_000_000 });
  } catch (error) {
    if (error instanceof CartridgeRefusedError) throw new ExtractionStopped(error.reason === "xml-too-large" ? "too-large" : "malformed");
    throw error;
  }

  const sink = new TextSink(limits.maxTextChars);
  // An explicit stack rather than recursion, so a deeply nested document cannot exhaust the call stack.
  const stack: XmlNode[] = [root];
  while (stack.length > 0 && !sink.full) {
    budget.spend();
    const node = stack.pop()!;
    if (typeof node === "string") continue;
    if (node.namespace === W) {
      if (node.local === "t") {
        for (const child of node.children) if (typeof child === "string") sink.write(child);
        continue;
      }
      if (node.local === "tab") sink.write("\t");
      else if (node.local === "br" || node.local === "cr") sink.write("\n");
      // Deleted text, field instructions and the like are not what the reader sees.
      if (node.local === "delText" || node.local === "instrText" || node.local === "del") continue;
      if (node.local === "p") stack.push(PARAGRAPH_END);
    }
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
    if (node === PARAGRAPH_END) sink.newline();
  }
  // Stopping at the cap with nodes left over cuts the document short.
  if (stack.length > 0) sink.truncated = true;
  return { text: sink.text(), truncated: sink.truncated };
}

/** A marker pushed beneath a paragraph's children, so the paragraph ends once they are done. */
const PARAGRAPH_END: XmlElement = { name: "", local: "", namespace: undefined, attributes: new Map(), children: [] };
