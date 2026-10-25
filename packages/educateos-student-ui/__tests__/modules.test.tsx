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
    body: "## Claims\n\nA **claim** is *arguable*. <script>alert(1)</script>\n\n- Specific\n- Debatable\n\nSee [the guide](https://open-lessons.example/guide) or [this](javascript:alert(1)).",
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

  it("shows nothing extra for a class with no published modules", async () => {
    await renderApp(fakeDistrict(), `/courses/${ENGLISH}`);
    await screen.findByRole("heading", { level: 2, name: "Activities" });
    expect(screen.queryByRole("heading", { level: 2, name: "Modules" })).toBeNull();
  });
});
