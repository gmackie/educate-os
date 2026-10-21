import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { ENGLISH, ESSAY, fakeDistrict } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";
import { setViewport } from "./viewport.ts";

/**
 * The page's outline as a screen reader user meets it: landmarks, headings, links and buttons in
 * document order, with their accessible names. A snapshot of this protects the structure of the
 * phone layout without depending on pixels.
 */
function outline(root: Element): string[] {
  const lines: string[] = [];
  const walk = (element: Element, depth: number) => {
    const tag = element.tagName.toLowerCase();
    const label = element.getAttribute("aria-label");
    const text = element.textContent?.replace(/\s+/g, " ").trim();
    let line: string | undefined;
    if (element.hasAttribute("data-layout")) line = `layout=${element.getAttribute("data-layout")}`;
    else if (tag === "header") line = "banner";
    else if (tag === "main") line = "main";
    else if (tag === "nav") line = `navigation "${label}"`;
    else if (/^h[1-6]$/.test(tag)) line = `heading ${tag.slice(1)} "${text}"`;
    else if (tag === "a") line = `link "${text}" → ${element.getAttribute("href")}`;
    else if (tag === "button") line = `button "${label ?? text}"`;
    if (line !== undefined) lines.push(`${"  ".repeat(depth)}${line}`);
    for (const child of element.children) walk(child, line === undefined ? depth : depth + 1);
  };
  walk(root, 0);
  return lines;
}

describe("layout", () => {
  it("puts the navigation along the bottom on a phone", async () => {
    setViewport("phone");
    const { container } = await renderApp(fakeDistrict());
    await screen.findByRole("link", { name: "Art · Grades 9–12" });
    const layout = container.querySelector("[data-layout]")!;
    expect(layout.getAttribute("data-layout")).toBe("phone");
    // The navigation comes after the main content, within thumb reach, and not in the header.
    expect(within(screen.getByRole("banner")).queryByRole("navigation")).toBeNull();
    expect(screen.getByRole("main").compareDocumentPosition(screen.getByRole("navigation", { name: "Main" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(outline(layout)).toMatchSnapshot();
  });

  it("keeps the navigation in the header on a desktop", async () => {
    const { container } = await renderApp(fakeDistrict());
    await screen.findByRole("heading", { level: 1 });
    expect(container.querySelector("[data-layout]")!.getAttribute("data-layout")).toBe("desktop");
    expect(within(screen.getByRole("banner")).getByRole("navigation", { name: "Main" })).toBeTruthy();
  });

  it("offers a skip link to the main content", async () => {
    await renderApp(fakeDistrict());
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
    expect(screen.getByRole("main").id).toBe("main");
  });
});

describe("the class helper's slot", () => {
  const activity = `/courses/${ENGLISH}/activities/${ESSAY}`;

  it("is hidden while the feature is off", async () => {
    await renderApp(fakeDistrict(), activity);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("complementary", { name: "Get help" })).toBeNull();
  });

  it("is hidden on an activity that allows no help, even with the feature on", async () => {
    await renderApp(fakeDistrict({ aiHelp: "none" }), activity, { aiHelp: true });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("complementary", { name: "Get help" })).toBeNull();
  });

  it("shows the activity's help level when the feature is on and the activity allows help", async () => {
    await renderApp(fakeDistrict({ aiHelp: "hints-only" }), activity, { aiHelp: true });
    const slot = await screen.findByRole("complementary", { name: "Get help" });
    expect(within(slot).getByText(/give you hints, but it won't do the work for you/)).toBeTruthy();
  });
});
