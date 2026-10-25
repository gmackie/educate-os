import { CartridgeRefusedError } from "./errors.ts";

/** One parsed element. Names keep their prefix; {@link local} and {@link namespace} are resolved. */
export interface XmlElement {
  /** The qualified name as written, such as `lomimscc:title`. */
  name: string;
  /** The name without its prefix. */
  local: string;
  /** The namespace URI the prefix (or the default namespace) resolves to. */
  namespace: string | undefined;
  /** Attributes by qualified name, entity references decoded. */
  attributes: ReadonlyMap<string, string>;
  children: XmlNode[];
}

/** An element or a run of character data. */
export type XmlNode = XmlElement | string;

/** Caps on what one document may cost to parse. */
export interface XmlLimits {
  /** The longest document accepted, in UTF-16 code units. */
  maxLength: number;
  /** The deepest element nesting accepted. */
  maxDepth: number;
  /** The most elements accepted. */
  maxElements: number;
}

/** Ample for a cartridge manifest of a few thousand items. */
export const DEFAULT_XML_LIMITS: XmlLimits = { maxLength: 4 * 1024 * 1024, maxDepth: 64, maxElements: 100_000 };

const NAME = /[A-Za-z_][\w.:-]*/y;
const SPACE = /\s*/y;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

const malformed = (message: string) => new CartridgeRefusedError("xml-malformed", message);

/**
 * Parses an XML document with no DTD support at all. A document declaring a DOCTYPE or an ENTITY
 * anywhere is refused outright, so no internal or external entity can be defined, expanded or
 * fetched (XXE and "billion laughs"); the only references accepted are the five predefined entities
 * and character references. Comments and processing instructions are skipped.
 *
 * @throws CartridgeRefusedError `xml-doctype`, `xml-too-large`, `xml-too-deep` or `xml-malformed`.
 */
export function parseXml(source: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlElement {
  if (source.length > limits.maxLength) throw new CartridgeRefusedError("xml-too-large", `the document is longer than ${limits.maxLength} characters`);
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(source)) throw new CartridgeRefusedError("xml-doctype", "documents with a DOCTYPE or entity declarations are not accepted");
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;

  const stack: { element: XmlElement; namespaces: ReadonlyMap<string, string> }[] = [];
  let root: XmlElement | undefined;
  let elements = 0;
  let at = 0;

  const skipPast = (terminator: string, what: string) => {
    const end = text.indexOf(terminator, at);
    if (end < 0) throw malformed(`an unterminated ${what}`);
    const body = text.slice(at, end);
    at = end + terminator.length;
    return body;
  };
  const appendText = (value: string) => {
    const parent = stack.at(-1);
    if (parent === undefined) {
      if (value.trim() !== "") throw malformed("text outside the root element");
      return;
    }
    parent.element.children.push(value);
  };

  while (at < text.length) {
    const lt = text.indexOf("<", at);
    if (lt !== at) {
      const end = lt < 0 ? text.length : lt;
      appendText(decodeReferences(text.slice(at, end)));
      at = end;
      continue;
    }
    if (text.startsWith("<?", at)) {
      at += 2;
      skipPast("?>", "processing instruction");
    } else if (text.startsWith("<!--", at)) {
      at += 4;
      skipPast("-->", "comment");
    } else if (text.startsWith("<![CDATA[", at)) {
      at += 9;
      const data = skipPast("]]>", "CDATA section");
      if (stack.length === 0) throw malformed("CDATA outside the root element");
      appendText(data);
    } else if (text.startsWith("<!", at)) {
      throw malformed("markup declarations are not accepted");
    } else if (text.startsWith("</", at)) {
      at += 2;
      const name = readName();
      SPACE.lastIndex = at;
      SPACE.exec(text);
      at = SPACE.lastIndex;
      if (text[at] !== ">") throw malformed(`a malformed end tag for ${name}`);
      at += 1;
      const open = stack.pop();
      if (open?.element.name !== name) throw malformed(`</${name}> does not close the open element`);
    } else {
      at += 1;
      const name = readName();
      const raw = new Map<string, string>();
      let selfClosing = false;
      for (;;) {
        SPACE.lastIndex = at;
        const space = SPACE.exec(text)![0];
        at = SPACE.lastIndex;
        if (text.startsWith("/>", at)) {
          at += 2;
          selfClosing = true;
          break;
        }
        if (text[at] === ">") {
          at += 1;
          break;
        }
        if (space === "") throw malformed(`a malformed start tag for ${name}`);
        const attribute = readName();
        SPACE.lastIndex = at;
        SPACE.exec(text);
        at = SPACE.lastIndex;
        if (text[at] !== "=") throw malformed(`attribute ${attribute} has no value`);
        at += 1;
        SPACE.lastIndex = at;
        SPACE.exec(text);
        at = SPACE.lastIndex;
        const quote = text[at];
        if (quote !== "\"" && quote !== "'") throw malformed(`attribute ${attribute} is not quoted`);
        at += 1;
        const value = skipPast(quote, "attribute value");
        if (value.includes("<")) throw malformed(`attribute ${attribute} contains <`);
        if (raw.has(attribute)) throw malformed(`attribute ${attribute} appears twice`);
        raw.set(attribute, decodeReferences(value));
      }

      if (stack.length === 0 && root !== undefined) throw malformed("more than one root element");
      if (stack.length + 1 > limits.maxDepth) throw new CartridgeRefusedError("xml-too-deep", `elements nest deeper than ${limits.maxDepth}`);
      if (++elements > limits.maxElements) throw new CartridgeRefusedError("xml-too-large", `the document has more than ${limits.maxElements} elements`);

      const namespaces = new Map(stack.at(-1)?.namespaces ?? []);
      for (const [key, value] of raw) {
        if (key === "xmlns") namespaces.set("", value);
        else if (key.startsWith("xmlns:")) namespaces.set(key.slice(6), value);
      }
      const colon = name.indexOf(":");
      const prefix = colon < 0 ? "" : name.slice(0, colon);
      const element: XmlElement = {
        name,
        local: colon < 0 ? name : name.slice(colon + 1),
        namespace: namespaces.get(prefix),
        attributes: raw,
        children: [],
      };
      stack.at(-1)?.element.children.push(element);
      root ??= element;
      if (!selfClosing) stack.push({ element, namespaces });
    }
  }
  if (root === undefined) throw malformed("no root element");
  if (stack.length > 0) throw malformed(`<${stack.at(-1)!.element.name}> is never closed`);
  return root;

  function readName(): string {
    NAME.lastIndex = at;
    const match = NAME.exec(text);
    if (match === null) throw malformed("expected a name");
    at = NAME.lastIndex;
    return match[0];
  }
}

/** Decodes the predefined entities and character references; any other reference is refused. */
function decodeReferences(value: string): string {
  return value.replace(/&([^;&\s]{0,10});?/g, (reference, body: string) => {
    if (!reference.endsWith(";")) throw malformed("an unterminated entity reference");
    const predefined = PREDEFINED[body];
    if (predefined !== undefined) return predefined;
    const numeric = /^#(?:x([0-9a-fA-F]{1,6})|(\d{1,7}))$/.exec(body);
    if (numeric === null) throw malformed(`the entity reference &${body}; is not one of the predefined entities`);
    const code = numeric[1] === undefined ? Number(numeric[2]) : Number.parseInt(numeric[1], 16);
    const allowed = code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
    if (!allowed) throw malformed(`the character reference &${body}; is not a valid XML character`);
    return String.fromCodePoint(code);
  });
}

/** The child elements of `element`, optionally only those with local name `local`. */
export function childElements(element: XmlElement, local?: string): XmlElement[] {
  return element.children.filter((node): node is XmlElement => typeof node !== "string" && (local === undefined || node.local === local));
}

/** The first child element with local name `local`. */
export function childElement(element: XmlElement, local: string): XmlElement | undefined {
  return childElements(element, local)[0];
}

/** Follows a path of local names through first matching children. */
export function descendant(element: XmlElement | undefined, ...path: string[]): XmlElement | undefined {
  let current = element;
  for (const local of path) current = current === undefined ? undefined : childElement(current, local);
  return current;
}

/** All of an element's character data, whitespace-collapsed and trimmed. */
export function textOf(element: XmlElement | undefined): string {
  if (element === undefined) return "";
  const parts: string[] = [];
  const walk = (node: XmlNode) => {
    if (typeof node === "string") parts.push(node);
    else node.children.forEach(walk);
  };
  walk(element);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** An attribute by its local name, whatever its prefix. Namespace declarations are not attributes. */
export function attributeOf(element: XmlElement, local: string): string | undefined {
  for (const [name, value] of element.attributes) {
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    if (name === local || name.endsWith(`:${local}`)) return value;
  }
  return undefined;
}
