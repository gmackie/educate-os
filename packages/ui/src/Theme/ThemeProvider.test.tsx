// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeModeButton, ThemeProvider, storedThemeMode, useTheme, type ThemeModeSource } from ".";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "test:theme-mode";

/** A system preference the test can change, as a person switching their OS to dark would. */
const fakeSystem = (initial: "light" | "dark") => {
  let dark = initial === "dark";
  const listeners = new Set<() => void>();
  window.matchMedia = ((media: string) => ({
    get matches() {
      return media === "(prefers-color-scheme: dark)" && dark;
    },
    media,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  return {
    set: (mode: "light" | "dark") => act(() => {
      dark = mode === "dark";
      for (const listener of listeners) listener();
    }),
    listeners,
  };
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const Probe = () => {
  const { themeMode, resolvedThemeMode, setThemeMode } = useTheme();
  return (
    <>
      <output>{`${themeMode}/${resolvedThemeMode}`}</output>
      <button type="button" onClick={() => setThemeMode("light")}>light</button>
    </>
  );
};

const render = (source: ThemeModeSource = storedThemeMode(KEY), announced: string[] = []) => {
  container = document.body.appendChild(document.createElement("div"));
  const mounted = createRoot(container);
  root = mounted;
  act(() => mounted.render(
    <ThemeProvider source={source}>
      <Probe />
      <ThemeModeButton onAnnounce={(message) => announced.push(message)} />
    </ThemeProvider>,
  ));
  return announced;
};

const shown = () => container?.querySelector("output")?.textContent;
const mode = () => document.documentElement.getAttribute("data-mode");
const themeButton = () => container!.querySelector<HTMLButtonElement>("button[aria-label^='Theme:']")!;

const unmount = () => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-mode");
  document.documentElement.style.colorScheme = "";
});
afterEach(unmount);

describe("ThemeProvider", () => {
  it("starts on system, showing the system's preference", () => {
    fakeSystem("dark");
    render();
    expect(shown()).toBe("system/dark");
    expect(mode()).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("follows the system preference live while on system", () => {
    const system = fakeSystem("light");
    render();
    expect(mode()).toBe("light");
    system.set("dark");
    expect(shown()).toBe("system/dark");
    expect(mode()).toBe("dark");
    system.set("light");
    expect(mode()).toBe("light");
  });

  it("keeps an explicit choice over the system preference", () => {
    const system = fakeSystem("dark");
    render();
    act(() => container!.querySelector<HTMLButtonElement>("button:not([aria-label])")!.click());
    expect(shown()).toBe("light/light");
    system.set("dark");
    expect(mode()).toBe("light");
  });

  it("remembers the choice for the next visit", () => {
    fakeSystem("light");
    render();
    act(() => themeButton().click()); // system -> light
    act(() => themeButton().click()); // light -> dark
    expect(localStorage.getItem(KEY)).toBe("dark");
    unmount();
    render();
    expect(shown()).toBe("dark/dark");
    expect(mode()).toBe("dark");
  });

  it("starts from whatever source the app gives it, and tells that source what was chosen", () => {
    fakeSystem("light");
    const written: string[] = [];
    render({ read: () => "dark", write: (chosen) => written.push(chosen) });
    expect(mode()).toBe("dark");
    act(() => themeButton().click());
    expect(written).toStrictEqual(["system"]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("stops listening to the system once unmounted", () => {
    const system = fakeSystem("light");
    render();
    expect(system.listeners.size).toBeGreaterThan(0);
    unmount();
    expect(system.listeners.size).toBe(0);
  });
});

describe("storedThemeMode", () => {
  it("treats a missing or unrecognised value as system", () => {
    expect(storedThemeMode(KEY).read()).toBe("system");
    localStorage.setItem(KEY, "sepia");
    expect(storedThemeMode(KEY).read()).toBe("system");
  });
});

describe("ThemeModeButton", () => {
  it("names the mode in force and the next one, steps system, light, dark, and announces each", () => {
    fakeSystem("dark");
    const announced = render();
    expect(themeButton().getAttribute("aria-label")).toBe("Theme: system (dark). Switch to light.");
    act(() => themeButton().click());
    expect(themeButton().getAttribute("aria-label")).toBe("Theme: light. Switch to dark.");
    act(() => themeButton().click());
    expect(themeButton().getAttribute("aria-label")).toBe("Theme: dark. Switch to system.");
    act(() => themeButton().click());
    expect(themeButton().getAttribute("aria-label")).toBe("Theme: system (dark). Switch to light.");
    expect(announced).toStrictEqual(["Theme: light", "Theme: dark", "Theme: system (dark)"]);
    expect(themeButton().type).toBe("button");
  });
});
