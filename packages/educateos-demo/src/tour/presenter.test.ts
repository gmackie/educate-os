import { describe, expect, it } from "vitest";
import { presenterCommand, presenterFromSearch } from "./presenter.ts";

const press = (key: string, target: EventTarget = document.body, modifiers: Partial<Record<"altKey" | "ctrlKey" | "metaKey", boolean>> = {}) =>
  presenterCommand({ key, target, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, ...modifiers });

describe("presenter mode", () => {
  it("is on with ?presenter, beside the district", () => {
    expect(presenterFromSearch("?district=cedarvalley&presenter")).toBe(true);
    expect(presenterFromSearch("?presenter=1")).toBe(true);
    expect(presenterFromSearch("?district=cedarvalley")).toBe(false);
  });

  it("maps 1, 2 and 3 to the administrator, the teacher and the student, and ? to its help", () => {
    expect(press("1")).toEqual({ kind: "persona", persona: "admin" });
    expect(press("2")).toEqual({ kind: "persona", persona: "teacher" });
    expect(press("3")).toEqual({ kind: "persona", persona: "student" });
    expect(press("?")).toEqual({ kind: "help" });
    expect(press("4")).toBeUndefined();
  });

  it("leaves keys alone while the visitor types in a field, or holds a modifier", () => {
    for (const html of ["<input>", "<textarea></textarea>", "<select></select>", "<div contenteditable='true'></div>", "<div role='textbox'><span></span></div>"]) {
      const host = document.body.appendChild(document.createElement("div"));
      host.innerHTML = html;
      const field = host.querySelector("span") ?? host.firstElementChild!;
      expect(press("1", field)).toBeUndefined();
      host.remove();
    }
    expect(press("1", document.body, { metaKey: true })).toBeUndefined();
    expect(press("2", document.body, { ctrlKey: true })).toBeUndefined();
  });
});
