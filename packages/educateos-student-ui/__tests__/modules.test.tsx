// SCHO-186: a class's published modules on its page, with pages rendered as text only.
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { ENGLISH, ESSAY, fakeDistrict } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";

const OUTLINE = {
  offeringId: ENGLISH,
  revision: 3,
  modules: [
    {
      id: "cmod_1",
      title: "Week 1: Claims",
      published: true,
      items: [
        { kind: "page", id: "cit_1", pageId: "cpg_1" },
        { kind: "activity", id: "cit_2", activityId: `act_${ESSAY.slice(4)}` },
        { kind: "activity", id: "cit_3", activityId: "act_not-assigned-to-me" },
        { kind: "link", id: "cit_4", title: "Argument guide", url: "https://open-lessons.example/argument" },
      ],
    },
    { id: "cmod_2", title: "Week 2: Evidence", published: true, items: [] },
  ],
  pages: [{
    id: "cpg_1",
    title: "What is a claim?",
    body: "## Claims\n\nA **claim** is *arguable*. <script>alert(1)</script>\n\n- Specific\n- Debatable\n\nSee [the guide](https://open-lessons.example/guide) or [this](javascript:alert(1)).\n\nSlides: https://open-lessons.example/slides. Not http://plain.example/page.",
  }],
};

describe("class modules", () => {
  it("lists published modules in order, with pages, assigned activities and links", async () => {
    await renderApp(fakeDistrict({ modules: { [ENGLISH]: OUTLINE } }), `/courses/${ENGLISH}`);
    const section = await screen.findByRole("region", { name: "Week 1: Claims" });
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles.slice(0, 2)).toStrictEqual(["Week 1: Claims", "Week 2: Evidence"]);

    expect(within(section).getByRole("heading", { level: 4, name: "What is a claim?" })).toBeTruthy();
    expect(within(section).getByRole("heading", { level: 5, name: "Claims" })).toBeTruthy();
    expect(within(section).getByText("claim").tagName).toBe("STRONG");
    expect(within(section).getAllByRole("listitem").some((li) => li.textContent === "Debatable")).toBe(true);
    expect(within(section).getByRole("link", { name: "Should the school day start later?" }).getAttribute("href")).toContain(ESSAY);
    expect(within(section).queryByText(/not-assigned/)).toBeNull();
    const guide = within(section).getByRole("link", { name: /Argument guide/ });
    expect(guide.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("never turns page text into markup or a script link", async () => {
    const { container } = await renderApp(fakeDistrict({ modules: { [ENGLISH]: OUTLINE } }), `/courses/${ENGLISH}`);
    const section = await screen.findByRole("region", { name: "Week 1: Claims" });
    expect(container.querySelector("script")).toBeNull();
    expect(section.textContent).toContain("<script>alert(1)</script>");
    expect(within(section).getByRole("link", { name: /the guide/ }).getAttribute("href")).toBe("https://open-lessons.example/guide");
    expect(within(section).queryByRole("link", { name: /^this/ })).toBeNull();
    expect(within(section).getByText("this")).toBeTruthy();
  });

  it("makes a bare https address a link, without its trailing full stop, and leaves other schemes as text (SCHO-222)", async () => {
    await renderApp(fakeDistrict({ modules: { [ENGLISH]: OUTLINE } }), `/courses/${ENGLISH}`);
    const section = await screen.findByRole("region", { name: "Week 1: Claims" });
    const slides = within(section).getByRole("link", { name: /https:\/\/open-lessons\.example\/slides/ });
    expect(slides.getAttribute("href")).toBe("https://open-lessons.example/slides");
    expect(slides.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(section).queryByRole("link", { name: /plain\.example/ })).toBeNull();
  });

  it("shows nothing extra for a class with no published modules", async () => {
    await renderApp(fakeDistrict(), `/courses/${ENGLISH}`);
    await screen.findByRole("heading", { level: 2, name: "Activities" });
    expect(screen.queryByRole("heading", { level: 2, name: "Modules" })).toBeNull();
  });
});

describe("page tables (SCHO-328)", () => {
  const PUNNETT = {
    ...OUTLINE,
    pages: [{
      id: "cpg_1",
      title: "Punnett Squares",
      body: "Each parent passes on **one allele**.\n\n| | **B** | **b** |\n|---|:-:|--:|\n| **B** | BB | Bb |\n| **b** | Bb | bb <script>x</script> |\n\nA **3 : 1** ratio.\n\n| Trait | Allele \\| symbol |\n| --- | --- |\n| Fur | [key](javascript:alert(1)) |",
    }],
  };

  it("renders a GFM table as a table with column and row headers", async () => {
    const { container } = await renderApp(fakeDistrict({ modules: { [ENGLISH]: PUNNETT } }), `/courses/${ENGLISH}`);
    const section = await screen.findByRole("region", { name: "Week 1: Claims" });
    const [square, traits] = within(section).getAllByRole("table");
    expect(within(square!).getAllByRole("columnheader").map((th) => th.textContent)).toStrictEqual(["B", "b"]);
    expect(within(square!).getAllByRole("rowheader").map((th) => th.textContent)).toStrictEqual(["B", "b"]);
    expect(within(square!).getByRole("columnheader", { name: "B" }).querySelector("strong")).toBeTruthy();
    expect(within(square!).getAllByRole("cell").map((td) => td.textContent)).toContain("BB");
    expect(within(square!).getAllByRole("columnheader")[1]!.className).toContain("text-right");
    expect(section.textContent).not.toContain("|---|");
    expect(within(section).getByText("3 : 1").tagName).toBe("STRONG");

    expect(within(traits!).getAllByRole("columnheader").map((th) => th.textContent)).toStrictEqual(["Trait", "Allele | symbol"]);
    expect(within(traits!).queryByRole("rowheader")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(within(traits!).queryByRole("link")).toBeNull();
  });

  it("leaves a pipe line without a delimiter row as paragraph text", async () => {
    const outline = { ...OUTLINE, pages: [{ id: "cpg_1", title: "Odds", body: "Heads | tails\nEither side." }] };
    await renderApp(fakeDistrict({ modules: { [ENGLISH]: outline } }), `/courses/${ENGLISH}`);
    const section = await screen.findByRole("region", { name: "Week 1: Claims" });
    expect(within(section).queryByRole("table")).toBeNull();
    expect(within(section).getByText("Heads | tails Either side.")).toBeTruthy();
  });
});
