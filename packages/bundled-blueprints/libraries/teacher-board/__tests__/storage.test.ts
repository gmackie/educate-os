// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getPreparation, savePreparation, sourceUrl, preparationMarkdown } from "../server.ts";
function memory() {
  const data = new Map<string, unknown>();
  return { data, async get<T>(key: string) { return data.get(key) as T | undefined; }, async put<T>(key: string, value: T) { data.set(key, structuredClone(value)); } };
}
describe("teacher preparation", () => {
  it("keeps notes per installation and does not store source records", async () => {
    const a = memory(), b = memory();
    const value = { notes: "Prepare observation cards", tasks: [{ id: "a", text: "Print journals", done: false }] };
    await savePreparation(a, value);
    expect(await getPreparation(a)).toEqual(value);
    expect(await getPreparation(b)).toEqual({ notes: "", tasks: [] });
    expect([...a.data.keys()]).toEqual(["preparation"]);
  });
  it("rejects oversized notes and duplicate task identifiers without overwriting", async () => {
    const storage = memory();
    await expect(savePreparation(storage, { notes: "x".repeat(12001), tasks: [] })).rejects.toThrow();
    await expect(savePreparation(storage, { notes: "", tasks: [{ id: "x", text: "A", done: false }, { id: "x", text: "B", done: true }] })).rejects.toThrow();
    expect(storage.data.size).toBe(0);
  });
  it("refuses executable and malformed source links", () => {
    expect(sourceUrl("javascript:alert(1)")).toBeUndefined();
    expect(sourceUrl("data:text/html,secret")).toBeUndefined();
    expect(sourceUrl("not a link")).toBeUndefined();
    expect(sourceUrl("https://example.org/a")).toBe("https://example.org/a");
  });
});

it("exports local preparation without reading a connector", () => {
  expect(preparationMarkdown({ notes: "Print journals", tasks: [{ id: "a", text: "Collect jars", done: true }] }))
    .toContain("- [x] Collect jars");
});
