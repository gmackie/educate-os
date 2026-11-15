// The shipped packs are reviewed data, so their rules are checked here rather than trusted: every
// answer is recomputed from its item, every word a child reads or builds is decodable with what was
// taught by then, a reading prompt never says the word it asks the child to read, and every
// distractor really differs from the answer.
import { describe, expect, it } from "vitest";
import { PACKS, currentPackFor, resolveActivity, type Activity, type Item } from "../src/content/index.ts";
import { scoreTry, answerKindFor } from "../src/scoring.ts";

const allItems = PACKS.flatMap((pack) => pack.activities.flatMap((activity) => activity.items.map((item) => ({ pack, activity, item }))));
const label = ({ activity, item }: { activity: Activity; item: Item }) => `${activity.key}/${item.key}`;

const words = (text: string) => text.toLowerCase().replace(/[^a-z\s']/g, " ").split(/\s+/).filter(Boolean);

function decodable(word: string, activity: Activity): boolean {
  const heart = new Set((activity.heartWords ?? []).map((w) => w.toLowerCase()));
  if (heart.has(word)) return true;
  const taught = new Set(activity.taught ?? []);
  return word.split("").every((letter) => taught.has(letter));
}

describe("shipped packs", () => {
  it("parses one reading and one math pack, both honest about their review", () => {
    expect(PACKS.map((p) => [p.id, p.version, p.track])).toEqual([
      ["reading-foundations", "1.0.0", "reading"],
      ["number-sense", "1.0.0", "math"],
    ]);
    // Neither has had the qualified review ADR-0016 requires; the library shows that.
    for (const pack of PACKS) expect(pack.review.status).toBe("draft");
  });

  it("starts every grade band on a real activity of its own pack", () => {
    for (const track of ["reading", "math"] as const) {
      const pack = currentPackFor(track);
      for (const band of ["K", "1", "2"] as const) {
        expect(resolveActivity({ pack: pack.id, version: pack.version, activity: pack.startFor[band]! }).pack.track).toBe(track);
      }
    }
  });

  it.each(allItems.map((entry) => [label(entry), entry] as const))("%s scores its own answer as right", (_name, { item }) => {
    const right = (() => {
      switch (answerKindFor(item)) {
        case "number": return { kind: "number" as const, value: (item as { answer: number }).answer };
        case "letters": return { kind: "letters" as const, letters: (item as { answer: string }).answer.split("") };
        case "observed": return { kind: "observed" as const, result: "independent" as const };
        default: return { kind: "choice" as const, choice: String((item as { answer: string }).answer) };
      }
    })();
    expect(scoreTry(item, right).correct).toBe(true);
  });

  it("recomputes every answer from its item", () => {
    for (const entry of allItems) {
      const { item } = entry;
      const name = label(entry);
      switch (item.type) {
        case "count-sounds": expect(item.answer, name).toBe(item.phonemes.length); break;
        case "build-word": {
          expect(item.answer, name).toBe(item.word);
          const tiles = [...item.tiles];
          for (const letter of item.word.split("")) {
            const at = tiles.indexOf(letter);
            expect(at, `${name} has a tile for ${letter}`).toBeGreaterThanOrEqual(0);
            tiles.splice(at, 1);
          }
          expect(tiles.length, `${name} has distractor tiles`).toBeGreaterThan(0);
          break;
        }
        case "count-objects": expect(item.answer, name).toBe(item.count); expect(item.choices.filter((c) => c === item.answer), name).toHaveLength(1); break;
        case "compare-groups": {
          expect(item.left, name).not.toBe(item.right);
          expect(item.answer, name).toBe((item.ask === "more") === (item.left > item.right) ? "left" : "right");
          break;
        }
        case "one-more-less": expect(item.answer, name).toBe(item.start + item.change); expect(item.choices.filter((c) => c === item.answer), name).toHaveLength(1); break;
        case "place-on-line": expect(item.answer, name).toBe(item.target); expect(item.target, name).toBeLessThanOrEqual(item.max); break;
        case "number-line-jump": {
          expect(item.answer, name).toBe(item.start + item.change);
          expect(item.start, name).toBeLessThanOrEqual(item.max);
          expect(item.answer, name).toBeGreaterThanOrEqual(0);
          expect(item.answer, name).toBeLessThanOrEqual(item.max);
          break;
        }
        case "read-aloud": break;
        default: {
          const keys = item.choices.map((c) => c.key);
          expect(keys.filter((k) => k === item.answer), `${name} offers its answer once`).toHaveLength(1);
          expect(new Set(item.choices.map((c) => c.picture?.label ?? c.text)).size, `${name} has distinct choices`).toBe(item.choices.length);
        }
      }
    }
  });

  it("asks a child to read or build only decodable words", () => {
    for (const entry of allItems) {
      const { activity, item } = entry;
      const name = label(entry);
      const read = item.type === "read-word" || item.type === "build-word" ? [item.word]
        : item.type === "read-sentence" || item.type === "read-aloud" ? words(item.sentence)
        : [];
      if (read.length === 0) continue;
      expect(activity.taught, `${name} declares what was taught`).toBeDefined();
      for (const word of read) expect(decodable(word, activity), `${name}: "${word}"`).toBe(true);
    }
  });

  it("never says the word or sentence a reading item asks the child to read", () => {
    for (const entry of allItems) {
      const { item } = entry;
      if (item.type === "read-word") {
        expect(words(item.prompt), label(entry)).not.toContain(item.word);
        expect(words(item.hint ?? ""), label(entry)).not.toContain(item.word);
      }
      if (item.type === "read-sentence" || item.type === "read-aloud") {
        expect(item.prompt.toLowerCase(), label(entry)).not.toContain(item.sentence.toLowerCase().replace(/[.!?]$/, ""));
      }
    }
  });

  it("teaches heart words before any sentence uses them", () => {
    const reading = currentPackFor("reading");
    const taughtBy = new Map<string, number>();
    reading.activities.forEach((a, index) => {
      if (reading.skills.find((s) => s.id === a.skill)?.strand === "heart-words") {
        for (const item of a.items) if (item.type === "find-word" && !taughtBy.has(item.answer)) taughtBy.set(item.answer, index);
      }
    });
    reading.activities.forEach((a, index) => {
      const teaches = reading.skills.find((s) => s.id === a.skill)?.strand === "heart-words";
      for (const word of a.heartWords ?? []) expect(taughtBy.get(word.toLowerCase()), `${a.key} uses ${word}`).toBeLessThanOrEqual(teaches ? index : index - 1);
    });
  });

  it("gives checks fresh items no practice activity of the same skill uses", () => {
    for (const pack of PACKS) {
      for (const check of pack.activities.filter((a) => a.mode === "check")) {
        const practiced = new Set(pack.activities.filter((a) => a.mode === "practice" && a.skill === check.skill).flatMap((a) => a.items.map((i) => JSON.stringify({ ...i, key: "", hint: "" }))));
        for (const item of check.items) expect(practiced.has(JSON.stringify({ ...item, key: "", hint: "" })), `${check.key}/${item.key}`).toBe(false);
      }
    }
  });
});
