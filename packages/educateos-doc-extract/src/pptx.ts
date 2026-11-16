import { CartridgeRefusedError } from "@educateos/cartridge/errors";
import { childElements, parseXml, type XmlElement, type XmlNode } from "@educateos/cartridge/xml";
import { readZip } from "@educateos/cartridge/zip";
import { ExtractionStopped, StepBudget, TextSink } from "./budget.ts";
import type { ExtractionLimits } from "./limits.ts";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const END: XmlElement = { name: "", local: "", namespace: undefined, attributes: new Map(), children: [] };

/** Reads slide text in the presentation's relationship order; never follows external targets. */
export async function extractPptxText(bytes: Uint8Array, limits: ExtractionLimits, budget: StepBudget): Promise<{ text: string; truncated: boolean }> {
  let files: ReadonlyMap<string, Uint8Array>;
  try {
    ({ files } = await readZip(bytes, {
      maxEntries: 2000, maxEntryBytes: limits.maxInflatedBytes,
      maxTotalBytes: limits.maxInflatedBytes, maxCompressionRatio: 100,
    }));
  } catch (error) {
    if (error instanceof CartridgeRefusedError) {
      throw new ExtractionStopped(["too-many-entries", "entry-too-large", "package-too-large", "compression-ratio"].includes(error.reason) ? "too-large" : "malformed");
    }
    throw error;
  }
  const xml = (path: string) => {
    const part = files.get(path);
    if (!part) throw new ExtractionStopped("malformed");
    budget.spend(part.byteLength);
    return parseXml(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(part), {
      maxLength: limits.maxInflatedBytes, maxDepth: 128, maxElements: 100_000,
    });
  };
  const presentation = xml("ppt/presentation.xml");
  const relationships = xml("ppt/_rels/presentation.xml.rels");
  if (presentation.namespace !== P || presentation.local !== "presentation" ||
      relationships.namespace !== RELS || relationships.local !== "Relationships") throw new ExtractionStopped("malformed");
  const list = childElements(presentation).find(node => node.namespace === P && node.local === "sldIdLst");
  const slides = list ? childElements(list).filter(node => node.namespace === P && node.local === "sldId") : [];
  if (slides.length > limits.maxPages) throw new ExtractionStopped("too-many-pages");
  const targets = new Map<string, string>();
  for (const rel of childElements(relationships)) {
    budget.spend();
    if (rel.namespace !== RELS || rel.local !== "Relationship" || rel.attributes.get("Type") !== `${R}/slide`) continue;
    const id = rel.attributes.get("Id");
    const target = rel.attributes.get("Target") ?? "";
    if (!id || targets.has(id) || rel.attributes.has("TargetMode") && rel.attributes.get("TargetMode") !== "Internal") throw new ExtractionStopped("malformed");
    const path = target.startsWith("/") ? target.slice(1) : `ppt/${target}`;
    if (!/^ppt\/slides\/[^/\\?#%]+\.xml$/.test(path)) throw new ExtractionStopped("malformed");
    targets.set(id, path);
  }
  const sink = new TextSink(limits.maxTextChars);
  let anyText = false;
  for (const [index, slide] of slides.entries()) {
    if (sink.full) { sink.truncated = true; break; }
    budget.spend();
    const relationship = [...slide.attributes].find(([name]) => {
      const [prefix, local] = name.split(":");
      return local === "id" && (slide.attributes.get(`xmlns:${prefix}`) ?? list?.attributes.get(`xmlns:${prefix}`) ?? presentation.attributes.get(`xmlns:${prefix}`)) === R;
    })?.[1];
    const path = relationship && targets.get(relationship);
    if (!path) throw new ExtractionStopped("malformed");
    const root = xml(path);
    if (root.namespace !== P || root.local !== "sld") throw new ExtractionStopped("malformed");
    sink.write(`\nSlide ${index + 1}\n`);
    const stack: XmlNode[] = [root];
    while (stack.length > 0 && !sink.full) {
      budget.spend();
      const node = stack.pop()!;
      if (typeof node === "string") continue;
      if (node === END) { sink.newline(); continue; }
      if (node.namespace === A) {
        if (node.local === "t") {
          for (const child of node.children) if (typeof child === "string") { sink.write(child); anyText ||= child.trim().length > 0; }
          continue;
        }
        if (node.local === "br") sink.write("\n");
        if (node.local === "p") stack.push(END);
      }
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
    }
    if (stack.length) sink.truncated = true;
  }
  if (!anyText) throw new ExtractionStopped(sink.truncated ? "too-large" : "no-text");
  return { text: sink.text(), truncated: sink.truncated };
}
