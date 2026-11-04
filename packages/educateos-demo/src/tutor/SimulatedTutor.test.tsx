// SCHO-328: free text the simulated tutor's script does not cover is not said to be screened or sent.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { findByText, getByRole, queryByText } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SimulatedTutor } from "./SimulatedTutor.tsx";

describe("the simulated tutor", () => {
  it("says an unscripted message went nowhere, rather than that Hall Monitor sent it on", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await act(async () => root.render(<SimulatedTutor band="6-8" activityTitle="Ideas on the Move" />));
    await userEvent.click(getByRole(container, "button", { name: "Ask Study Coach" }));
    await userEvent.type(getByRole(container, "textbox", { name: "Your message" }), "What should I eat for lunch?");
    await userEvent.click(getByRole(container, "button", { name: "Send" }));

    expect(await findByText(container, /Not in this preview's script, so it went nowhere/)).toBeDefined();
    expect(queryByText(container, /allowed, sent to/)).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it("introduces Study Coach on a history activity without talking about math", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await act(async () => root.render(<SimulatedTutor band="6-8" activityTitle="What Do Hammurabi's Laws Tell Us?" />));
    await userEvent.click(getByRole(container, "button", { name: "Ask Study Coach" }));
    expect(container.textContent).toContain("Let's look at how you used the source.");
    expect(container.textContent).not.toMatch(/\bmath\b/i);
    act(() => root.unmount());
    container.remove();
  });
});
