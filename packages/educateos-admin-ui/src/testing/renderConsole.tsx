// Renders the console into jsdom for the journey tests and wires Testing Library's queries and
// user-event into React's act(), as @testing-library/react would. Not a test file.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach } from "vitest";
import { configure } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import type { DistrictApiClient } from "@educateos/api-client";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import type { SchoolManifest } from "@educateos/shell";
import { AdminApp } from "../App.tsx";

// jsdom has no PointerEvent, which Base UI's controls construct when they are pressed.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = class PointerEvent extends MouseEvent {} as typeof window.PointerEvent;
}

// Nor Blob.text(), which the roster upload reads files with.
function readBlobText(this: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(this);
  });
}
if (typeof Blob.prototype.text !== "function") Blob.prototype.text = readBlobText;

type ActGlobal = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actGlobal = globalThis as ActGlobal;
actGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const inActEnvironment = <T,>(value: boolean, run: () => T): T => {
  const previous = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = value;
  try {
    return run();
  } finally {
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
  }
};

configure({
  // Waiting polls the DOM while React commits on its own, outside act().
  asyncWrapper: async (callback) => {
    const previous = actGlobal.IS_REACT_ACT_ENVIRONMENT;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const result = await callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return result;
    } finally {
      actGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  },
  // Each dispatched event's updates are flushed before the next.
  eventWrapper: (callback) => inActEnvironment(true, () => {
    let result: unknown;
    act(() => { result = callback(); });
    return result;
  }) as void,
});

/** Where the console keeps the theme an administrator chose, as main.tsx has it. */
export const THEME_KEY = "educateos:theme-mode";

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  window.location.hash = "";
  localStorage.clear();
});

/** The school whose shell frames the console on the district origin. */
export const SCHOOL: SchoolManifest = {
  v: 1,
  name: "Northfield",
  origin: "https://learn.northfield.example",
  brand: {},
  signIn: [],
  features: { ai: true, mobile: false, family: true },
};

/**
 * Renders the console at `screen` against `client`, framed by `school`'s shell as main.tsx frames
 * it (or unframed, `false`, as a host that embeds it does), and a user-event session to drive it.
 */
export function renderConsole(client: DistrictApiClient, screen = "dashboard", school: SchoolManifest | false = SCHOOL) {
  window.location.hash = `#/${screen}`;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => root.render(
    <ThemeProvider source={storedThemeMode(THEME_KEY)}>
      <AdminApp client={client} {...(school === false ? {} : { shell: { school } })} />
    </ThemeProvider>,
  ));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, user: userEvent.setup() };
}
