// QTI 2.1 and 3.0 assessments, read as quizzes (SCHO-191). A test (`imsqti_test_xmlv2p1`,
// `imsqti_test_xmlv3p0`) becomes one quiz of the items it references; an item placed on its own
// (`imsqti_item_xmlv2p1`, `imsqti_item_xmlv3p0`) becomes a quiz of one. Each item is read for one
// interaction of a kind EducateOS scores the same way: a choice (one or several), a text entry (a
// number within a tolerance, or text), or extended text (an essay). Anything else, and any item
// without a key a choice or text entry needs, is reported as a loss, never silently dropped. The
// item's own response processing is not run: EducateOS scores the key it declares.
//
// QTI 3.0 names elements `qti-simple-choice` and attributes `response-identifier` where QTI 2.1
// writes `simpleChoice` and `responseIdentifier`; both read alike here. Markup is reduced to text.
import { CartridgeRefusedError } from "./errors.ts";
import { packagePath } from "./plan.ts";
import { attributeOf, parseXml, type XmlElement, type XmlNode } from "./xml.ts";

/** A choice an imported item offers. */
export interface QtiChoice {
  id: string;
  text: string;
}

/** One imported item, in the shape a EducateOS quiz item is written in (without its ID). */
export type QtiQuizItem =
  | { type: "multiple-choice"; prompt: string; points: number; choices: QtiChoice[]; correctChoiceId: string }
  | { type: "multiple-select"; prompt: string; points: number; choices: QtiChoice[]; correctChoiceIds: string[]; scoring: "all-or-nothing" | "partial" }
  | { type: "true-false"; prompt: string; points: number; correct: boolean }
  | { type: "numeric"; prompt: string; points: number; answer: number; tolerance: number }
  | { type: "short-answer"; prompt: string; points: number; acceptedAnswers: string[] }
  | { type: "essay"; prompt: string; points: number };

/** Why a QTI item or assessment was not carried. */
export type QtiLossReason =
  /** The file is not a QTI 2.1 or 3.0 item or test that could be read. */
  | "invalid-qti"
  /** An item whose interaction EducateOS does not score (its `type` names it), or one with no key to score against. */
  | "unsupported-qti-item"
  /** An item the test references that the package does not contain. */
  | "missing-file";

/** One item or assessment not carried, and why. Never its content. */
export interface QtiLoss {
  identifier: string;
  reason: QtiLossReason;
  /** The interaction, for an unsupported item. */
  type?: string;
}

/** The most items one imported quiz keeps. */
export const MAX_IMPORTED_QUIZ_ITEMS = 200;
/** The longest imported prompt, in characters; longer ones are cut. */
export const MAX_IMPORTED_QTI_PROMPT_LENGTH = 5_000;
/** The longest imported choice, in characters; longer ones are cut. */
export const MAX_IMPORTED_QTI_CHOICE_LENGTH = 1_000;

/** QTI item resource types this importer reads. */
export const QTI_ITEM_TYPE = /^imsqti_item_xmlv(2p1|3p0)$/;
/** QTI test resource types this importer reads. */
export const QTI_TEST_TYPE = /^imsqti_test_xmlv(2p1|3p0)$/;

/** An element's name as QTI 2.1 writes it: QTI 3.0's `qti-simple-choice` reads as `simpleChoice`. */
function nameOf(element: XmlElement): string {
  return element.local.startsWith("qti-") ? element.local.slice(4).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) : element.local;
}

/** An attribute by its QTI 2.1 name, or the kebab-case name QTI 3.0 gives it. */
function attr(element: XmlElement, name: string): string | undefined {
  return attributeOf(element, name) ?? attributeOf(element, name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
}

const elements = (element: XmlElement) => element.children.filter((node): node is XmlElement => typeof node !== "string");
const child = (element: XmlElement | undefined, name: string) => (element === undefined ? undefined : elements(element).find((e) => nameOf(e) === name));
const children = (element: XmlElement | undefined, name: string) => (element === undefined ? [] : elements(element).filter((e) => nameOf(e) === name));

function descendants(element: XmlElement, match: (e: XmlElement) => boolean): XmlElement[] {
  const found: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of elements(e)) {
      if (match(c)) found.push(c);
      walk(c);
    }
  };
  walk(element);
  return found;
}

const BLOCK = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "tr", "blockquote", "pre", "section", "article", "prompt"]);

/** An element's text with markup removed: blocks become paragraphs, list items bullets, images their alt text. Skipped elements leave nothing. */
function textWithout(element: XmlElement, skip: (e: XmlElement) => boolean = () => false): string {
  const parts: string[] = [];
  const walk = (node: XmlNode) => {
    if (typeof node === "string") {
      parts.push(node.replace(/\s+/g, " "));
      return;
    }
    if (skip(node)) return;
    const name = nameOf(node);
    if (name === "img") {
      const alt = attributeOf(node, "alt");
      if (alt !== undefined && alt.trim() !== "") parts.push(` [${alt.trim()}] `);
      return;
    }
    if (name === "br") parts.push("\n");
    if (name === "li") parts.push("\n- ");
    if (BLOCK.has(name)) parts.push("\n\n");
    node.children.forEach(walk);
    if (BLOCK.has(name)) parts.push("\n\n");
  };
  element.children.forEach(walk);
  return parts.join("").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

/** A QTI identifier as a choice ID (`[a-z0-9][a-z0-9_-]*`), made unique among `taken`. */
function choiceId(identifier: string, index: number, taken: Set<string>): string {
  let id = identifier.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
  if (id === "" || taken.has(id)) id = `c${index + 1}`;
  for (let n = 2; taken.has(id); n++) id = `c${index + 1}-${n}`;
  taken.add(id);
  return id;
}

/** The value of a declaration's default (`defaultValue` / `qti-default-value`), as a number. */
function defaultNumber(declaration: XmlElement | undefined): number | undefined {
  const value = child(child(declaration, "defaultValue"), "value");
  const number = value === undefined ? Number.NaN : Number(textWithout(value));
  return Number.isFinite(number) ? number : undefined;
}

/** What an item is worth: its `MAXSCORE` outcome's default, else its `SCORE` outcome's `normalMaximum`, else 1. */
function pointsOf(item: XmlElement): number {
  const outcomes = children(item, "outcomeDeclaration");
  const maxScore = defaultNumber(outcomes.find((o) => attr(o, "identifier") === "MAXSCORE"));
  const normal = Number(attr(outcomes.find((o) => attr(o, "identifier") === "SCORE") ?? item, "normalMaximum"));
  const points = maxScore ?? (Number.isFinite(normal) ? normal : 1);
  return points > 0 && points <= 1_000 ? points : 1;
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** The interactions EducateOS reads, by QTI name. Every other `…Interaction` is a loss. */
const INTERACTIONS = new Set(["choiceInteraction", "textEntryInteraction", "extendedTextInteraction"]);

/**
 * Reads one QTI 2.1 or 3.0 assessment item. Returns the item, or the loss that kept it out.
 *
 * @param identifier What the loss is reported under: the item's place in the cartridge.
 */
export function readQtiItem(source: string, identifier: string): { title: string; item: QtiQuizItem } | { loss: QtiLoss } {
  let root: XmlElement;
  try {
    root = parseXml(source);
  } catch (error) {
    if (error instanceof CartridgeRefusedError && error.reason !== "xml-malformed") throw error;
    return { loss: { identifier, reason: "invalid-qti" } };
  }
  if (nameOf(root) !== "assessmentItem") return { loss: { identifier, reason: "invalid-qti" } };
  const title = (attr(root, "title") ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const body = child(root, "itemBody");
  if (body === undefined) return { loss: { identifier, reason: "invalid-qti" } };
  const isInteraction = (e: XmlElement) => nameOf(e).endsWith("Interaction");
  const interactions = descendants(body, isInteraction);
  if (interactions.length !== 1) return { loss: { identifier, reason: "unsupported-qti-item", type: interactions.length === 0 ? "no-interaction" : "multiple-interactions" } };
  const interaction = interactions[0]!;
  const kind = nameOf(interaction);
  if (!INTERACTIONS.has(kind)) return { loss: { identifier, reason: "unsupported-qti-item", type: kind.slice(0, 100) } };

  const stem = textWithout(body, isInteraction);
  const ownPrompt = child(interaction, "prompt");
  const prompt = clip([stem, ownPrompt === undefined ? "" : textWithout(ownPrompt)].filter((t) => t !== "").join("\n\n"), MAX_IMPORTED_QTI_PROMPT_LENGTH);
  if (prompt === "") return { loss: { identifier, reason: "invalid-qti" } };
  const points = pointsOf(root);
  if (kind === "extendedTextInteraction") return { title, item: { type: "essay", prompt, points } };

  const responseId = attr(interaction, "responseIdentifier");
  const declaration = children(root, "responseDeclaration").find((d) => attr(d, "identifier") === responseId);
  const correct = children(child(declaration, "correctResponse"), "value").map((v) => textWithout(v));
  const mapped = children(child(declaration, "mapping"), "mapEntry").map((e) => ({ key: attr(e, "mapKey") ?? "", value: Number(attr(e, "mappedValue")) }));
  const noKey = { loss: { identifier, reason: "unsupported-qti-item" as const, type: `${kind}-without-key` } };

  if (kind === "textEntryInteraction") {
    const baseType = declaration === undefined ? undefined : attr(declaration, "baseType");
    if (baseType === "float" || baseType === "integer") {
      const answer = Number(correct[0]);
      if (!Number.isFinite(answer)) return noKey;
      // An absolute tolerance is kept; a relative one becomes the absolute tolerance it allows at the answer.
      const equal = descendants(child(root, "responseProcessing") ?? root, (e) => nameOf(e) === "equal")[0];
      const mode = equal === undefined ? undefined : attr(equal, "toleranceMode");
      const bound = Number((equal === undefined ? undefined : attr(equal, "tolerance"))?.trim().split(/\s+/)[0]);
      const tolerance = !Number.isFinite(bound) || bound < 0 ? 0 : mode === "absolute" ? bound : mode === "relative" ? Math.abs(answer) * bound / 100 : 0;
      return { title, item: { type: "numeric", prompt, points, answer, tolerance } };
    }
    const accepted = [...new Set([...correct, ...mapped.filter((m) => m.value > 0).map((m) => m.key)].map((a) => a.trim().slice(0, 200)).filter((a) => a !== ""))].slice(0, 20);
    if (accepted.length === 0) return noKey;
    return { title, item: { type: "short-answer", prompt, points, acceptedAnswers: accepted } };
  }

  // A choice interaction.
  const taken = new Set<string>();
  const simple = descendants(interaction, (e) => nameOf(e) === "simpleChoice");
  if (simple.length < 2 || simple.length > 20) return { loss: { identifier, reason: "unsupported-qti-item", type: `${kind}-with-${simple.length}-choices` } };
  const choices = simple.map((c, i) => ({ qti: attr(c, "identifier") ?? "", id: choiceId(attr(c, "identifier") ?? "", i, taken), text: clip(textWithout(c), MAX_IMPORTED_QTI_CHOICE_LENGTH) }));
  if (choices.some((c) => c.text === "")) return { loss: { identifier, reason: "invalid-qti" } };
  const keyed = choices.filter((c) => correct.includes(c.qti));
  if (keyed.length === 0) return noKey;
  const visible = choices.map(({ id, text }) => ({ id, text }));
  const cardinality = declaration === undefined ? "single" : (attr(declaration, "cardinality") ?? "single");
  if (cardinality === "single") {
    if (keyed.length !== 1) return noKey;
    const texts = choices.map((c) => c.text.trim().toLowerCase());
    if (choices.length === 2 && texts.includes("true") && texts.includes("false")) {
      return { title, item: { type: "true-false", prompt, points, correct: keyed[0]!.text.trim().toLowerCase() === "true" } };
    }
    return { title, item: { type: "multiple-choice", prompt, points, choices: visible, correctChoiceId: keyed[0]!.id } };
  }
  // A mapping that credits choices one by one is partial credit; a bare key is all or nothing.
  const scoring = mapped.length > 0 ? "partial" : "all-or-nothing";
  return { title, item: { type: "multiple-select", prompt, points, choices: visible, correctChoiceIds: keyed.map((c) => c.id), scoring } };
}

/**
 * A path relative to the file at `from`, both package paths.
 *
 * @throws CartridgeRefusedError `unsafe-path` for a path that climbs above the package.
 */
function resolveFrom(from: string, href: string): string {
  if (href.startsWith("/")) throw new CartridgeRefusedError("unsafe-path", "a QTI test references an absolute path");
  const parts = from.split("/").slice(0, -1);
  for (const segment of href.split(/[?#]/)[0]!.split("/")) {
    if (segment === "..") {
      if (parts.pop() === undefined) throw new CartridgeRefusedError("unsafe-path", "a QTI test references a path outside the package");
    } else if (segment !== "." && segment !== "") {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

/** A quiz read from a QTI test or item, with what it lost. */
export interface QtiQuiz {
  title: string;
  items: QtiQuizItem[];
  losses: QtiLoss[];
  /** Whether items beyond {@link MAX_IMPORTED_QUIZ_ITEMS}, or long prompts or choices, were cut. */
  truncated: boolean;
}

/**
 * Reads a QTI test, or a lone item, at `path` in the package as a quiz. A test's items are the
 * `assessmentItemRef`s in it, in order, each resolved relative to the test file.
 *
 * @param identifier The placement in the cartridge, which each loss is reported under (an item's as `<placement>/<item ref>`).
 */
export function readQtiQuiz(files: ReadonlyMap<string, Uint8Array>, path: string, kind: "test" | "item", identifier: string): QtiQuiz | { loss: QtiLoss } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const read = (at: string): string | undefined => {
    const bytes = files.get(at);
    if (bytes === undefined) return undefined;
    try {
      return decoder.decode(bytes);
    } catch {
      return "";
    }
  };
  const source = read(path);
  if (source === undefined) return { loss: { identifier, reason: "missing-file" } };
  if (kind === "item") {
    const result = readQtiItem(source, identifier);
    if ("loss" in result) return { title: "", items: [], losses: [result.loss], truncated: false };
    return { title: result.title, items: [result.item], losses: [], truncated: result.item.prompt.length >= MAX_IMPORTED_QTI_PROMPT_LENGTH };
  }
  let test: XmlElement;
  try {
    test = parseXml(source);
  } catch (error) {
    if (error instanceof CartridgeRefusedError && error.reason !== "xml-malformed") throw error;
    return { loss: { identifier, reason: "invalid-qti" } };
  }
  if (nameOf(test) !== "assessmentTest") return { loss: { identifier, reason: "invalid-qti" } };
  const items: QtiQuizItem[] = [];
  const losses: QtiLoss[] = [];
  let truncated = false;
  for (const ref of descendants(test, (e) => nameOf(e) === "assessmentItemRef")) {
    const at = `${identifier}/${(attr(ref, "identifier") ?? "item").slice(0, 100)}`;
    const href = attr(ref, "href");
    if (href === undefined) {
      losses.push({ identifier: at, reason: "invalid-qti" });
      continue;
    }
    const itemSource = read(packagePath(resolveFrom(path, href)));
    if (itemSource === undefined) {
      losses.push({ identifier: at, reason: "missing-file" });
      continue;
    }
    const result = readQtiItem(itemSource, at);
    if ("loss" in result) {
      losses.push(result.loss);
    } else if (items.length >= MAX_IMPORTED_QUIZ_ITEMS) {
      truncated = true;
    } else {
      truncated ||= result.item.prompt.length >= MAX_IMPORTED_QTI_PROMPT_LENGTH;
      items.push(result.item);
    }
  }
  return { title: (attr(test, "title") ?? "").replace(/\s+/g, " ").trim().slice(0, 200), items, losses, truncated };
}
