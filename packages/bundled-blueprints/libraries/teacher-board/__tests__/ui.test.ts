import { afterEach, expect, it, vi } from "vitest";
import { mountBoard, type BoardApi, type BoardOptions } from "../client.ts";
const options: BoardOptions = {
  title: "Research Kit", eyebrow: "Teacher research", description: "Find sources", connector: "Web Search", setup: "Bind WEB_SEARCH", inputLabel: "Keywords", inputType: "search", inputValue: "pond habitats", empty: "No sources yet",
  sample: { title: "Fictional pond", subtitle: "Fictional", refreshedAt: "2026-11-04T00:00:00Z", cards: [{ id: "s", title: "Sample", detail: "Example", label: "Fictional" }] },
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (text: string) => [...document.querySelectorAll("button")].find(b => b.textContent === text)!;
afterEach(() => { document.body.replaceChildren(); document.head.replaceChildren(); });
it("keeps samples opt-in, renders untrusted content as text and clears denied records", async () => {
  const refresh = vi.fn().mockResolvedValueOnce({ title: "Live", subtitle: "Source", refreshedAt: "2026-11-04T00:00:00Z", cards: [{ id: "a", title: "<img src=x onerror=alert(1)>", detail: "Private source text", label: "Excerpt", url: "javascript:alert(1)" }] }).mockRejectedValueOnce(new Error("denied"));
  const api: BoardApi = { getPreparation: async () => ({ notes: "", tasks: [] }), savePreparation: vi.fn(), refresh };
  mountBoard(api, options);
  await tick();
  expect(refresh).not.toHaveBeenCalled();
  button("Try fictional example").click();
  expect(document.body.textContent).toContain("Fictional example");
  expect(api.savePreparation).not.toHaveBeenCalled();
  button("Refresh source").click(); await tick();
  expect(document.body.textContent).toContain("Private source text");
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("a")).toBeNull();
  button("Refresh source").click(); await tick();
  expect(document.body.textContent).not.toContain("Private source text");
  expect(document.body.textContent).toContain("Source unavailable");
});
it("saves teacher edits and retains them when saving fails", async () => {
  const savePreparation = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  mountBoard({ getPreparation: async () => ({ notes: "Existing", tasks: [] }), savePreparation, refresh: vi.fn() }, options);
  await tick();
  const notes = document.querySelector("textarea")!;
  notes.value = "Prepare a journal"; notes.dispatchEvent(new Event("input"));
  button("Save preparation").click(); await tick();
  expect(notes.value).toBe("Prepare a journal");
  expect(document.body.textContent).toContain("Could not save");
  button("Save preparation").click(); await tick();
  expect(savePreparation).toHaveBeenLastCalledWith({ notes: "Prepare a journal", tasks: [] });
});
it("prevents overwriting stored preparation if the initial read fails", async () => {
  mountBoard({ getPreparation: async () => { throw new Error("offline"); }, savePreparation: vi.fn(), refresh: vi.fn() }, options);
  await tick();
  expect(button("Save preparation").disabled).toBe(true);
  expect(document.querySelector("textarea")!.disabled).toBe(true);
});

it("prints the current notes even before saving", async () => {
  mountBoard({ getPreparation: async () => ({ notes: "Existing note", tasks: [] }), savePreparation: vi.fn(), refresh: vi.fn() }, options);
  await tick();
  expect(document.querySelector(".print-notes")!.textContent).toBe("Existing note");
  const notes = document.querySelector("textarea")!;
  notes.value = "New preparation"; notes.dispatchEvent(new Event("input"));
  expect(document.querySelector(".print-notes")!.textContent).toBe("New preparation");
});
