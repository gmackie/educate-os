import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryHistory } from "@tanstack/react-router";
import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import { StudentApp } from "../src/App.tsx";
import type { Embedding, StudentFeatures } from "../src/AppContext.tsx";
import type { DistrictApiClient, PairingClient } from "@educateos/api-client";
import type { SchoolManifest } from "@educateos/shell";

/** Where the app keeps the theme a student chose, as main.tsx has it. */
export const THEME_KEY = "educateos:theme-mode";

/** The school the district origin serves, as its manifest says: no AI and no phone app unless a test turns them on. */
export const SCHOOL: SchoolManifest = {
  v: 1,
  name: "Northfield",
  origin: "https://learn.northfield.example",
  brand: {},
  signIn: [],
  features: { ai: false, mobile: false, family: true },
};

/** A school with its features changed. */
export const schoolWith = (features: Partial<SchoolManifest["features"]>): SchoolManifest => ({ ...SCHOOL, features: { ...SCHOOL.features, ...features } });

/** How the app is mounted beyond its district and features. */
export interface RenderOptions {
  /**
   * The school whose shell frames the app, as main.tsx frames it on the district origin; `false`
   * renders it unframed, as a host that embeds it does. Defaults to {@link SCHOOL}, or to unframed
   * where an `embedding` is given.
   */
  school?: SchoolManifest | false;
  pairing?: PairingClient;
}

let mounted: { root: Root; container: HTMLElement }[] = [];

/** Renders the Learning Home at `path` against `district`, as a host embeds it if `embedding` is given, and returns its container. */
export async function renderApp(district: DistrictApiClient, path = "/", features: StudentFeatures = { aiHelp: false }, embedding?: Embedding, options: RenderOptions = {}): Promise<{ container: HTMLElement; unmount: () => void }> {
  const school = options.school ?? (embedding === undefined ? SCHOOL : false);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const entry = { root, container };
  mounted.push(entry);
  await act(async () => {
    root.render(
      <ThemeProvider source={storedThemeMode(THEME_KEY)}>
        <StudentApp
          client={district}
          features={features}
          history={createMemoryHistory({ initialEntries: [path] })}
          {...(embedding === undefined ? {} : { embedding })}
          {...(school === false ? {} : { shell: { school } })}
          {...(options.pairing === undefined ? {} : { pairing: options.pairing })}
        />
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

/** Opens the shell's account menu, where sign-out, Connect phone and Your devices are, and returns it. */
export async function openAccountMenu(): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: /account menu/ });
  if (button.getAttribute("aria-expanded") !== "true") await userEvent.setup().click(button);
  return screen.getByRole("list", { name: "Account" });
}
