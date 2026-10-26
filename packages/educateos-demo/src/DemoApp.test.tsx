import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { findByRole, findByText, getByRole, queryByRole } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemoApp } from "./DemoApp.tsx";

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  window.history.replaceState(null, "", "/demo/");
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root.render(<DemoApp />));
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
    await userEvent.click(await findByRole(container, "link", { name: "English Language Arts · Grade 9" }, BOOT));
    expect(await findByRole(banner(), "button", { name: /Things to try 1\/3/ }, BOOT)).toBeDefined();
    expect(window.location.hash).toBe("#/courses/off_nf-eng9-fall-p3");

    await userEvent.click(getByRole(banner(), "button", { name: "Reset demo" }));
    expect(window.location.hash).toBe("");
    expect(queryByRole(banner(), "button", { name: "Switch persona" })).toBeNull();
    expect(await findByRole(container, "heading", { name: "Try EducateOS" })).toBeDefined();
    expect(container.textContent).not.toContain("things to try done");
  });
});
