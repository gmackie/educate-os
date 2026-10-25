// YAML at the API and CLI boundary. A district configuration may be written in YAML, but only the
// part of YAML that means the same thing as JSON: one document, no anchors, aliases or tags.
import { isAlias, LineCounter, parseAllDocuments, visit } from "yaml";
import type { ConfigProblem } from "./compile.ts";

/** The largest YAML document accepted, in UTF-16 code units. A district configuration is a few kilobytes. */
export const MAX_YAML_DOCUMENT_LENGTH = 256 * 1024;

/** A YAML document read as plain data, or every reason it was refused. */
export type YamlReadResult = { ok: true; value: unknown } | { ok: false; problems: ConfigProblem[] };

/**
 * Reads a YAML configuration document into plain data for {@link compileDistrictConfig}.
 *
 * It accepts YAML 1.2 under the core schema, and refuses whatever would let the text mean more
 * than its JSON equivalent: more than one document, anchors and aliases (which can expand a small
 * text into a huge value), explicit tags (`!!binary`, `!custom`), duplicate keys and keys that are
 * not strings. Every problem carries the line it is on. Messages never quote the document, which may
 * hold a credential the compiler would have refused.
 */
export function readYamlConfigDocument(text: string): YamlReadResult {
  if (text.length > MAX_YAML_DOCUMENT_LENGTH) {
    return refuse("", `the document is longer than ${MAX_YAML_DOCUMENT_LENGTH} characters`);
  }
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    stringKeys: true,
    prettyErrors: false,
    lineCounter,
  });
  if (!Array.isArray(documents) || documents.length !== 1) {
    return refuse("", "a configuration is exactly one YAML document");
  }
  const document = documents[0]!;
  const lineOf = (offset: number | undefined) => (offset === undefined ? "" : ` (line ${lineCounter.linePos(offset).line})`);
  const problems: ConfigProblem[] = document.errors.map((error) => ({
    code: "invalid-yaml",
    path: "",
    message: `${error.message}${lineOf(error.pos[0])}`,
  }));
  visit(document, {
    Node(_key, node) {
      const at = lineOf(node.range?.[0]);
      if (isAlias(node)) problems.push({ code: "invalid-yaml", path: "", message: `aliases are not allowed${at}` });
      else if (node.anchor !== undefined) problems.push({ code: "invalid-yaml", path: "", message: `anchors are not allowed${at}` });
      if (node.tag !== undefined) problems.push({ code: "invalid-yaml", path: "", message: `tags are not allowed${at}` });
    },
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: document.toJS({ maxAliasCount: 0 }) };
}

function refuse(path: string, message: string): YamlReadResult {
  return { ok: false, problems: [{ code: "invalid-yaml", path, message }] };
}
