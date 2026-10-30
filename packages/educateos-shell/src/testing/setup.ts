// Test environment: React's act() around Testing Library's events and waits (what
// @testing-library/react would configure), and a clean page per test.
import { act } from "react";
import { afterEach } from "vitest";
import { configure } from "@testing-library/dom";
import { setViewport } from "./viewport.ts";

const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
env.IS_REACT_ACT_ENVIRONMENT = true;

configure({
  asyncWrapper: async (callback) => {
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const result = await callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return result;
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  },
  // An event user-event fires during one of its own waits still goes through act(), so act() is
  // on for its length.
  eventWrapper: (callback) => {
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = true;
    let result: unknown;
    try {
      act(() => {
        result = callback();
      });
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = previous;
    }
    return result;
  },
});

setViewport("wide");
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
if (globalThis.PointerEvent === undefined) {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {} as typeof globalThis.PointerEvent;
}

afterEach(() => {
  localStorage.clear();
  setViewport("wide");
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-mode");
});
