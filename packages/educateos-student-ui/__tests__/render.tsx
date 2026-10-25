import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach } from "vitest";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import { StudentApp } from "../src/App.tsx";
import type { StudentFeatures } from "../src/AppContext.tsx";
import type { DistrictApiClient } from "@educateos/api-client";

/** Where the app keeps the theme a student chose, as main.tsx has it. */
export const THEME_KEY = "educateos:theme-mode";

let mounted: { root: Root; container: HTMLElement }[] = [];

/** Renders the Learning Home at `path` against `district`, and returns its container. */
export async function renderApp(district: DistrictApiClient, path = "/", features: StudentFeatures = { aiHelp: false }): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const entry = { root, container };
  mounted.push(entry);
  await act(async () => {
    root.render(
      <ThemeProvider source={storedThemeMode(THEME_KEY)}>
        <StudentApp client={district} features={features} history={createMemoryHistory({ initialEntries: [path] })} />
      </ThemeProvider>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      mounted = mounted.filter((m) => m !== entry);
    },
  };
}

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted = [];
  localStorage.clear();
});

/** What the polite live region last announced. */
export const announcement = (): string => document.querySelector('[aria-live="polite"]')?.textContent?.trim() ?? "";
