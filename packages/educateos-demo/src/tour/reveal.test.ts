// SCHO-328: a tour step scrolls its point of interest into view once the new screen shows it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revealWhenShown } from "./reveal.ts";

const scrolled: Element[] = [];

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  window.location.hash = "#/courses/a";
});

afterEach(() => {
  document.body.replaceChildren();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

const panel = (id: string) => Object.assign(document.createElement("aside"), { id, className: "tutor" });

describe("revealWhenShown", () => {
  it("scrolls to the element once the page is at the step's route and shows it", async () => {
    revealWhenShown(".tutor", "#/courses/b");
    // The screen being left has one too, but the page is not at the step's route yet.
    document.body.append(panel("old"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(scrolled).toStrictEqual([]);

    document.body.replaceChildren();
    window.location.hash = "#/courses/b";
    const tutor = panel("new");
    document.body.append(tutor);
    await vi.waitFor(() => expect(scrolled).toStrictEqual([tutor]));
    // Only once.
    document.body.append(panel("later"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(scrolled).toStrictEqual([tutor]);
  });

  it("scrolls at once when the screen already shows it, and does nothing once stopped", async () => {
    window.location.hash = "#/courses/b";
    const tutor = panel("there");
    document.body.append(tutor);
    revealWhenShown(".tutor", "#/courses/b");
    await vi.waitFor(() => expect(scrolled).toStrictEqual([tutor]));

    scrolled.length = 0;
    document.body.replaceChildren();
    const stop = revealWhenShown(".tutor", "#/courses/b");
    stop();
    document.body.append(panel("too-late"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(scrolled).toStrictEqual([]);
  });
});
