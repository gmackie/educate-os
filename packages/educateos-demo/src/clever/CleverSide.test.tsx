import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { findByRole, getByRole, getByText, queryByRole, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootCedarValley, type CedarValleyDistrict } from "../districts/cedarvalley.ts";
import { CleverSide } from "./CleverSide.tsx";
import { CleverSideStore } from "./cleverSide.ts";

let root: Root | undefined;
let container: HTMLElement;

const render = async (district: CedarValleyDistrict, current = true) => {
  const side = new CleverSideStore(district.clever, district.roster, new Set(["prn_cv-student-rowan"]));
  const onOpenRosterSync = vi.fn();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<CleverSide side={side} admin={{ name: "Elaine Park", current }} onOpenRosterSync={onOpenRosterSync} />));
  const panel = getByRole(container, "complementary", { name: "Clever side" });
  return { side, panel, onOpenRosterSync };
};

const expand = (panel: HTMLElement) => userEvent.click(getByRole(panel, "button", { name: "Clever side" }));

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("the Clever side panel", () => {
  it("starts collapsed to its toggle, and opens beside the app", async () => {
    const district = await bootCedarValley();
    const { panel } = await render(district);
    const toggle = getByRole(panel, "button", { name: "Clever side" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(queryByRole(panel, "heading", { name: "Change the district in Clever (simulated)" })).toBeNull();
    await expand(panel);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getByRole(panel, "region", { name: "Change the district in Clever (simulated)" }).id).toBe(toggle.getAttribute("aria-controls"));
  });

  it("sends the visitor to the first sync before anything can change", async () => {
    const district = await bootCedarValley();
    const { panel, onOpenRosterSync } = await render(district, false);
    await expand(panel);
    expect(getByText(panel, /hasn't synced from Clever yet/)).toBeDefined();
    expect(queryByRole(panel, "button", { name: /^Add a new student/ })).toBeNull();
    await userEvent.click(getByRole(panel, "button", { name: "Open Roster sync as Elaine Park" }));
    expect(onOpenRosterSync).toHaveBeenCalledOnce();
  });

  it("withdraws, adds and moves students in Clever, listing each as pending until a sync brings it in", async () => {
    const district = await bootCedarValley();
    await district.roster.sync();
    const { panel, onOpenRosterSync } = await render(district);
    await expand(panel);
    const pending = () => getByRole(panel, "region", { name: "Pending in Clever" });
    expect(pending().textContent).toContain("Nothing waiting");

    const earthScience = getByRole(panel, "region", { name: "Earth Science 8 - Whitaker" });
    // The demo's own student stays, and is in every class at the middle school already, so nothing about them can change.
    expect(within(earthScience).getByText("Rowan Ellis")).toBeDefined();
    expect(queryByRole(earthScience, "button", { name: "Change Rowan Ellis in Earth Science 8 - Whitaker" })).toBeNull();

    await userEvent.click(getByRole(earthScience, "button", { name: "Change Bao Nguyen in Earth Science 8 - Whitaker" }));
    await userEvent.click(await findByRole(document.body, "menuitem", { name: "Withdraw from the district" }));
    expect(within(pending()).getByText("Withdrew Bao Nguyen from the district")).toBeDefined();
    expect(getByRole(panel, "status").textContent).toBe("Withdrew Bao Nguyen from the district. It is pending in Clever until the next sync.");
    expect(within(earthScience).queryByText("Bao Nguyen")).toBeNull();

    await userEvent.click(getByRole(panel, "button", { name: "Add a new student to Algebra I - Whitaker" }));
    expect(within(getByRole(panel, "region", { name: "Algebra I - Whitaker" })).getByText("Maya Chen")).toBeDefined();

    await userEvent.click(getByRole(panel, "button", { name: "Change Sofia Marquez in English 8 - Ferreira" }));
    await userEvent.click(await findByRole(document.body, "menuitem", { name: "Move to Earth Science 8 - Whitaker" }));
    expect(within(pending()).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Withdrew Bao Nguyen from the district",
      "Added Maya Chen to Algebra I - Whitaker",
      "Moved Sofia Marquez from English 8 - Ferreira to Earth Science 8 - Whitaker",
    ]);
    expect(getByText(panel, "3 pending")).toBeDefined();
    expect(within(pending()).getByText("Run a delta sync in Roster sync to bring these in.")).toBeDefined();
    await userEvent.click(within(pending()).getByRole("button", { name: "Open Roster sync" }));
    expect(onOpenRosterSync).toHaveBeenCalledOnce();

    await act(async () => {
      await district.clientFor(district.sessions.start({ issuer: district.cleverSso.issuer, subject: "26c04a9db351d58f26c0499d", credential: "person" })).call("admin.runRosterSync", { body: { mode: "delta" } });
    });
    expect(pending().textContent).toContain("Nothing waiting");
    expect(queryByRole(panel, "button", { name: "Open Roster sync" })).toBeNull();
  });
});
