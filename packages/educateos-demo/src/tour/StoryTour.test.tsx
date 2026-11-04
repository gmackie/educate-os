// SCHO-328: on a phone the demo's banner and the tour strip keep to a line each, so the app keeps
// the screen. jsdom has no layout, so this checks the classes that do it at the `sm` breakpoint.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getByRole, getByText, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { DemoBanner } from "../DemoBanner.tsx";
import { districtInfo } from "../districts/index.ts";
import { StoryTour } from "./StoryTour.tsx";

const render = async (element: React.ReactElement) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => root.render(element));
  return container;
};

describe("on a phone", () => {
  it("the tour strip keeps the step's title to one cut-short line and the Next button to its arrow", async () => {
    const container = await render(<StoryTour at={2} visited={new Set([0, 1, 2])} open={false} onOpenChange={() => {}} ready onGo={() => {}} />);
    const strip = getByRole(container, "region", { name: "K-12 tour" });
    expect(strip.firstElementChild!.className).not.toMatch(/(^| )flex-wrap/);
    const title = getByText(strip, /^Step 3 · K-2:/).parentElement!;
    expect(title.className).toContain("max-sm:truncate");
    const next = within(strip).getByRole("button", { name: "Next step" });
    expect(getByText(next, "Next step").className).toContain("max-sm:sr-only");
  });

  it("the banner says what this is in its short form", async () => {
    const container = await render(<DemoBanner info={districtInfo("northfield")} persona={undefined} done={new Set()} onSwitchPersona={() => {}} onReset={() => {}} />);
    const banner = getByRole(container, "banner", { name: "Demo" });
    expect(getByText(banner, "Fictional · in your browser · AI simulated").parentElement!.className).toContain("sm:hidden");
    expect(getByText(banner, /everything stays in your browser/).parentElement!.className).toContain("max-sm:hidden");
  });
});
