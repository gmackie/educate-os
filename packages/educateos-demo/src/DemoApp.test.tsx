import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { findByRole, findByText, getByRole, queryByRole, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemoApp } from "./DemoApp.tsx";

let root: Root;
let container: HTMLElement;

const mount = async (url: string) => {
  window.history.replaceState(null, "", url);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root.render(<DemoApp />));
};

beforeEach(async () => {
  await mount("/demo/");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const BOOT = { timeout: 60_000 };
const banner = () => getByRole(container, "banner", { name: "Demo" });

/** Picks a persona on the picker by the role its card names, such as "Grade 9 student". */
const choose = async (role: string) => {
  await userEvent.click(await findByRole(container, "button", { name: new RegExp(`^${role}`) }));
};

const switchPersona = () => userEvent.click(getByRole(banner(), "button", { name: "Switch persona" }));

/** Opens EducateOS from the Clever portal's tiles, once the district is up. */
const openEducateOS = async () => {
  const tile = await findByRole(container, "button", { name: "EducateOS" });
  await waitFor(() => expect((tile as HTMLButtonElement).disabled).toBe(false), BOOT);
  await userEvent.click(tile);
};

describe("the demo", () => {
  it("opens each persona's own app at its home, over one shared district", async () => {
    expect(banner().textContent).toContain("Fictional district · everything stays in your browser · AI is off");

    await choose("Grade 9 student");
    expect(await findByRole(container, "heading", { name: "Hi, Amara Okafor" }, BOOT)).toBeDefined();
    expect(getByRole(banner(), "button", { name: /Things to try 0\/3/ })).toBeDefined();

    await switchPersona();
    await choose("English 9 teacher");
    expect(await findByRole(container, "heading", { name: "My classes" }, BOOT)).toBeDefined();
    expect(await findByText(container, "English 9 · Period 3")).toBeDefined();

    await switchPersona();
    await choose("Amara's guardian");
    expect(await findByRole(container, "heading", { name: "Amara Okafor's classes" }, BOOT)).toBeDefined();

    await switchPersona();
    await choose("District administrator");
    expect(await findByRole(container, "heading", { name: "Dashboard" }, BOOT)).toBeDefined();
    // The seed's two essays are on record, so every persona is reading the same district.
    expect(await findByText(container, /2 submissions/, {}, BOOT)).toBeDefined();
  });

  it("starts over on reset: back to the picker, with the hash route and progress cleared", async () => {
    await choose("Grade 9 student");
    await findByRole(container, "heading", { name: "Hi, Amara Okafor" }, BOOT);
    await userEvent.click(await findByRole(container, "link", { name: "English 9 · Period 3" }, BOOT));
    expect(await findByRole(banner(), "button", { name: /Things to try 1\/3/ }, BOOT)).toBeDefined();
    expect(window.location.hash).toBe("#/courses/off_nf-eng9-fall-p3");

    await userEvent.click(getByRole(banner(), "button", { name: "Reset demo" }));
    expect(window.location.hash).toBe("");
    expect(queryByRole(banner(), "button", { name: "Switch persona" })).toBeNull();
    expect(await findByRole(container, "heading", { name: "Try EducateOS" })).toBeDefined();
    expect(container.textContent).not.toContain("things to try done");
  });
});

const CLEVER_NOTICE = "Simulated Clever district — runs on our Clever fakes, built to Clever's published v3.1 API. Not connected to Clever.";

describe("the demo's districts", () => {
  it("switches to Cedar Valley, which its administrator rosters from Clever before its teacher and student can sign in", async () => {
    expect(banner().textContent).not.toContain(CLEVER_NOTICE);
    await userEvent.click(getByRole(container, "tab", { name: "Cedar Valley · Clever + Google Classroom" }));
    expect(window.location.search).toBe("?district=cedarvalley");
    expect(banner().textContent).toContain(CLEVER_NOTICE);

    // Cedar Valley is entered through its portal: who you are in Clever, then the EducateOS tile.
    expect(await findByRole(container, "heading", { name: "Cedar Valley USD portal (simulated Clever portal)" }, BOOT)).toBeDefined();
    await choose("Grade 8 student");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "Cedar Valley USD hasn't synced from Clever yet" }, BOOT)).toBeDefined();
    // The sign-in itself worked, and its steps are there to look at.
    await userEvent.click(await findByRole(container, "button", { name: /^Under the hood/ }));
    expect(getByRole(container, "list", { name: "Clever sign-in steps" }).children).toHaveLength(11);
    await userEvent.click(getByRole(container, "button", { name: "Sign in as Elaine Park" }));
    expect(getByRole(container, "button", { name: "Sign out of the portal" })).toBeDefined();
    await openEducateOS();
    // The administrator lands on the console's own Roster sync screen, where the first sync is run.
    expect(await findByRole(container, "heading", { name: "Roster sync" }, BOOT)).toBeDefined();
    expect(window.location.hash).toBe("#/roster-sync");
    await userEvent.click(await findByRole(container, "button", { name: "Run complete sync" }, BOOT));
    const result = await findByRole(container, "region", { name: "Complete sync just now" }, BOOT);
    expect(within(result).getByText("The roster is up to date")).toBeDefined();

    await switchPersona();
    await choose("Earth Science and Algebra teacher");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "My classes" }, BOOT)).toBeDefined();
    expect(await findByText(container, "Earth Science 8 · Earth Science 8 - Whitaker", {}, BOOT)).toBeDefined();

    await switchPersona();
    await choose("Grade 8 student");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "Hi, Rowan Ellis" }, BOOT)).toBeDefined();
    // The notice stays on every screen of the district.
    expect(banner().textContent).toContain(CLEVER_NOTICE);

    await switchPersona();
    await userEvent.click(getByRole(container, "tab", { name: "Northfield · OneRoster + Canvas" }));
    expect(window.location.search).toBe("");
    expect(banner().textContent).not.toContain(CLEVER_NOTICE);
    expect(await findByRole(container, "button", { name: /^Grade 9 student/ })).toBeDefined();
  });

  it("opens Cedar Valley from a link, and reset boots it again unrostered", async () => {
    act(() => root.unmount());
    container.remove();
    await mount("/demo/?district=cedarvalley");
    expect(banner().textContent).toContain(CLEVER_NOTICE);
    await choose("District administrator");
    await openEducateOS();
    await userEvent.click(await findByRole(container, "button", { name: "Run complete sync" }, BOOT));
    await findByRole(container, "region", { name: "Complete sync just now" }, BOOT);

    await userEvent.click(getByRole(banner(), "button", { name: "Reset demo" }));
    expect(window.location.search).toBe("?district=cedarvalley");
    await choose("Earth Science and Algebra teacher");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "Cedar Valley USD hasn't synced from Clever yet" }, BOOT)).toBeDefined();
  });

  it("changes Cedar Valley in Clever from its Clever side, and a delta sync in Roster sync brings the changes in", async () => {
    act(() => root.unmount());
    container.remove();
    await mount("/demo/?district=cedarvalley");
    await choose("Earth Science and Algebra teacher");
    await openEducateOS();
    const side = await findByRole(container, "complementary", { name: "Clever side" }, BOOT);
    await userEvent.click(getByRole(side, "button", { name: "Clever side" }));
    // Nothing can change in Clever before the first sync; the panel sends the visitor to it, as the
    // administrator, whom the portal signs in.
    await userEvent.click(getByRole(side, "button", { name: "Open Roster sync as Elaine Park" }));
    expect(await findByText(container, "Signed in to the portal as Elaine Park")).toBeDefined();
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "Roster sync" }, BOOT)).toBeDefined();
    await userEvent.click(await findByRole(container, "button", { name: "Run complete sync" }, BOOT));
    await findByRole(container, "region", { name: "Complete sync just now" }, BOOT);

    const earthScience = await findByRole(side, "region", { name: "Earth Science 8 - Whitaker" }, BOOT);
    await userEvent.click(getByRole(earthScience, "button", { name: "Change Bao Nguyen in Earth Science 8 - Whitaker" }));
    await userEvent.click(await findByRole(document.body, "menuitem", { name: "Withdraw from the district" }));
    await userEvent.click(getByRole(side, "button", { name: "Add a new student to Algebra I - Whitaker" }));
    const pending = getByRole(side, "region", { name: "Pending in Clever" });
    expect(within(pending).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Withdrew Bao Nguyen from the district",
      "Added Maya Chen to Algebra I - Whitaker",
    ]);
    expect(within(pending).getByText("Run a delta sync in Roster sync to bring these in.")).toBeDefined();

    await userEvent.click(getByRole(container, "button", { name: "Run delta sync" }));
    const result = await findByRole(container, "region", { name: "Delta sync just now" }, BOOT);
    // People added, updated, deactivated: Maya Chen in, Bao Nguyen out, and no one else.
    expect(within(result).getByRole("row", { name: /^People 1 0 1$/ })).toBeDefined();
    expect(await findByText(pending, "Nothing waiting: Cedar Valley has every change Clever has.", {}, BOOT)).toBeDefined();

    // The teacher's classes show it on their next load.
    await switchPersona();
    await choose("Earth Science and Algebra teacher");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "My classes" }, BOOT)).toBeDefined();
  });
});
