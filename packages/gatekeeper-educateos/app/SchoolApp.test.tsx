// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/dom";
import type { DistrictApiClient } from "@educateos/api-client";
import { installHashLocation } from "@gadgets/ui/hash-location";
import { ThemeProvider } from "@gadgets/ui/theme";
import { createFrameLocation, type FrameLocation } from "./frameLocation.ts";
import { SchoolApp } from "./SchoolApp.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A district that is down: the screens' own chrome, which shows regardless, is what these tests read. */
const quietDistrict: DistrictApiClient = { call: () => Promise.reject(new Error("The district is down.")) };
const hostTheme = { read: () => "light" as const, subscribe: () => () => {} };

let root: Root | undefined;
let reported: string[] = [];

const open = (path: string): FrameLocation => {
  reported = [];
  const location = createFrameLocation(path, (moved) => reported.push(moved));
  installHashLocation(location.hash);
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => root!.render(
    <ThemeProvider source={hostTheme}>
      <SchoolApp client={quietDistrict} location={location} embedding={{ districtOrigin: "https://district.example" }} />
    </ThemeProvider>,
  ));
  return location;
};

beforeEach(() => {
  window.matchMedia = ((media: string) => ({ matches: false, media, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

describe("the School app frame", () => {
  it("moves the admin console between its screens without moving the frame's own address", async () => {
    open("/admin");
    await act(async () => {});
    act(() => screen.getByRole("link", { name: "Guardians" }).click());
    expect(reported).toStrictEqual(["/admin/guardians"]);
    expect(screen.getByRole("link", { name: "Guardians" }).getAttribute("aria-current")).toBe("page");
    expect(window.location.hash).toBe("");
  });

  it("shows the screen the host moves to, and offers no theme choice of its own", () => {
    const location = open("/admin/classes");
    expect(screen.getByRole("heading", { name: "EducateOS district admin" })).toBeTruthy();
    act(() => location.show("/teach"));
    expect(screen.queryByRole("heading", { name: "EducateOS district admin" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Theme:/ })).toBeNull();
    expect(reported).toStrictEqual([]);
  });

  it("takes the Learning Home's type sizes only while it is showing", () => {
    const location = open("/learn");
    expect(document.documentElement.dataset.app).toBe("learning-home");
    act(() => location.show("/admin"));
    expect(document.documentElement.dataset.app).toBeUndefined();
  });
});
