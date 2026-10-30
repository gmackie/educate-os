import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";
import type { DistrictApiClient } from "@educateos/api-client";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import type { SchoolManifest } from "@educateos/shell";
import { App } from "../src/App.tsx";
import { DistrictApiProvider } from "../src/DistrictApi.tsx";

/** Where Teacher Studio keeps the theme a teacher chose, as main.tsx has it. */
export const THEME_KEY = "educateos:theme-mode";

/** The school whose shell frames Teacher Studio on the district origin: no AI unless a test turns it on. */
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

let mounted: { root: Root; container: HTMLElement } | undefined;

afterEach(() => {
  if (mounted !== undefined) {
    const { root, container } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = undefined;
  }
  window.location.hash = "";
  localStorage.clear();
});

/**
 * Renders Teacher Studio over `client`, at `hash`, framed by `school`'s shell as main.tsx frames it,
 * or unframed (`false`) as a host that embeds it does.
 */
export const renderApp = async (client: DistrictApiClient, hash = "#/", school: SchoolManifest | false = SCHOOL) => {
  window.location.hash = hash;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <ThemeProvider source={storedThemeMode(THEME_KEY)}>
      <DistrictApiProvider client={client}><App {...(school === false ? {} : { shell: { school } })} /></DistrictApiProvider>
    </ThemeProvider>,
  ));
  mounted = { root, container };
  return userEvent.setup();
};

/** Follows the URL's hash change, which jsdom reports asynchronously. */
export const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Waits until the screen's main heading reads `name`. */
export const onScreen = (name: string | RegExp) => waitFor(() => screen.getByRole("heading", { level: 1, name }));
