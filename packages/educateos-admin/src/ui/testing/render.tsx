// Renders the admin into jsdom and wires Testing Library and user-event into React's act(), as the
// district admin console's suite does. Not a test file.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach } from "vitest";
import { configure } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import { AdminApp } from "../App.tsx";
import { createAdminClient } from "../app/client.ts";
import { THEME_KEY } from "../theme.ts";
import type { FakeAdminApi } from "./fakeApi.ts";

// jsdom has no PointerEvent, which Base UI's controls construct when they are pressed.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = class PointerEvent extends MouseEvent {} as typeof window.PointerEvent;
}

type ActGlobal = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actGlobal = globalThis as ActGlobal;
actGlobal.IS_REACT_ACT_ENVIRONMENT = true;

configure({
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
  eventWrapper: (callback) => {
    const previous = actGlobal.IS_REACT_ACT_ENVIRONMENT;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      let result: unknown;
      act(() => { result = callback(); });
      return result as void;
    } finally {
      actGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  },
});

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  window.location.hash = "";
  localStorage.clear();
});

/** Renders the admin at `hash` against a fake API. */
export function renderAdmin(api: FakeAdminApi, hash = "#/workspaces") {
  window.location.hash = hash;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => root.render(
    <ThemeProvider source={storedThemeMode(THEME_KEY)}>
      <AdminApp client={createAdminClient(api.fetch)} />
    </ThemeProvider>,
  ));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, user: userEvent.setup() };
}
