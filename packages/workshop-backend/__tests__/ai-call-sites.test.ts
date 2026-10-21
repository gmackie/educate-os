// The kernel's AI call sites, declared. Every call that obtains a model (getModel(),
// getDecisionModel()) and every request that names its own call site (`callSite: "..."`) carries an
// `// ai-call-site: <labels>` marker just above it, naming (space-separated) the AiCallSite labels
// its requests can carry. This test reads the source and fails when a call has no marker, a marker
// names a label the AiCallSite union lacks, or the markers differ from MANIFEST below -- so a new
// path into a model is a deliberate change to this file and to
// docs/schoolos/hall-monitor/ingress-matrix.md, whose rows ai-call-ingress.test.ts drives.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- ?raw imports have no type declaration
import GUARD_API from "../../workshop-shared/src/ai-call-guard.ts?raw";

const SOURCES = import.meta.glob<string>(
    ["../src/**/*.ts", "!../src/generated/**"], { query: "?raw", import: "default", eager: true });

/** Each marker in the kernel, in file and line order: the file, and the labels it declares. */
const MANIFEST: [file: string, labels: string][] = [
  ["admin-settings.ts", "admin.model-test"],
  ["agent.ts", "chat.compaction"], // Anthropic's native compaction
  ["agent.ts", "chat.compaction"], // summary compaction, for every other model
  ["ai-models.ts", "gadget.llm"],
  ["ai-models.ts", "gadget.decision"],
  // An agent turn, labelled by what started it.
  ["overseer.ts", "chat.message chat.external chat.steer agent.callback agent.spawn chat.agent"],
  ["overseer.ts", "chat.binding-name"],
  ["overseer.ts", "chat.title"],
  ["overseer.ts", "gadget.title"],
];

// Labels no call site declares: the guard's fallback for a caller that names none.
const UNDECLARED = new Set(["unattributed"]);

const MARKER = /^\s*\/\/ ai-call-site: (.+)$/;
// A call that obtains a model, or a request that names its own call site.
const MODEL_CALL = /(?<!function )\b(getModel|getDecisionModel)\s*\(|\bcallSite:\s*"/;
// How far above a call its marker may be: the statement's own lines plus the marker.
const MARKER_REACH = 6;
// What builds or guards a model handle, which only getModel() and getDecisionModel() may call.
const HANDLE_BUILDER = new RegExp("(?<!function )\\b(makeHandle|routeModel|routeDecisionModel|" +
    "guardModelHandle|guardDecisionModel)\\s*\\(");

const sources = Object.entries(SOURCES as Record<string, string>)
    .map(([path, text]) => ({ file: path.replace("../src/", ""), lines: text.split("\n") }))
    .toSorted((a, b) => a.file.localeCompare(b.file));

function isComment(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

// The AiCallSite union's labels, as workshop-shared declares them.
function declaredSites(): string[] {
  let union = /export type AiCallSite =([^;]*);/.exec(GUARD_API as string)![1];
  return [...union.matchAll(/\|\s*"([^"]+)"/g)].map(match => match[1]);
}

function markers() {
  return sources.flatMap(({ file, lines }) => lines.flatMap((line, index) => {
    let match = MARKER.exec(line);
    return match ? [{ file, line: index + 1, labels: match[1].trim() }] : [];
  }));
}

describe("AI call-site manifest", () => {
  it("reads the kernel's source", () => {
    expect(sources.map(source => source.file)).toEqual(
        expect.arrayContaining(["ai-models.ts", "overseer.ts", "agent.ts"]));
    expect(declaredSites()).toContain("chat.message");
  });

  it("marks every call that obtains a model, or names its own call site", () => {
    let unmarked: string[] = [];
    let used = new Set<string>();
    for (let { file, lines } of sources) {
      lines.forEach((line, index) => {
        if (isComment(line) || !MODEL_CALL.test(line.replace(/\s\/\/\s.*$/, ""))) return;
        let marker = lines.slice(Math.max(0, index - MARKER_REACH), index)
            .findLastIndex(above => MARKER.test(above));
        if (marker < 0) {
          unmarked.push(`${file}:${index + 1}: ${line.trim()}`);
        } else {
          used.add(`${file}:${Math.max(0, index - MARKER_REACH) + marker + 1}`);
        }
      });
    }
    expect(unmarked, "add an `// ai-call-site: <label>` marker and a MANIFEST entry").toEqual([]);
    // A marker that marks nothing is stale.
    expect(markers().map(({ file, line }) => `${file}:${line}`).filter(at => !used.has(at)))
        .toEqual([]);
  });

  it("declares exactly the markers in the source", () => {
    expect(markers().map(({ file, labels }) => [file, labels])).toEqual(MANIFEST);
  });

  it("names only labels of the AiCallSite union, and every one of them somewhere", () => {
    let sites = declaredSites();
    let named = MANIFEST.flatMap(([, labels]) => labels.split(" "));
    expect(named.filter(label => !sites.includes(label))).toEqual([]);
    expect(sites.filter(site => !named.includes(site) && !UNDECLARED.has(site))).toEqual([]);
  });

  // getModel() and getDecisionModel() are where the guard is applied, so a handle built any other
  // way would reach a model unguarded.
  it("builds and guards model handles only in ai-models.ts", () => {
    let outside = sources.flatMap(({ file, lines }) => file === "ai-models.ts" ? [] :
        lines.flatMap((line, index) =>
            !isComment(line) && HANDLE_BUILDER.test(line) ? [`${file}:${index + 1}`] : []));
    expect(outside).toEqual([]);
  });
});
