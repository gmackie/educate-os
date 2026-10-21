// Test environment: React's act() around Testing Library's events and waits (what
// @testing-library/react would configure), the browser APIs jsdom lacks, and a clean tab per test.
import { act } from "react";
import { afterEach, vi } from "vitest";
import { configure } from "@testing-library/dom";
import { setViewport } from "./viewport.ts";

const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
env.IS_REACT_ACT_ENVIRONMENT = true;

configure({
  // Waits poll the DOM while React renders on its own schedule, so act() is off during them.
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
  eventWrapper: (callback) => {
    let result: unknown;
    act(() => {
      result = callback();
    });
    return result;
  },
});

setViewport("desktop");
URL.createObjectURL = vi.fn(() => "blob:https://learn.northfield.example/object");
URL.revokeObjectURL = vi.fn();
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  sessionStorage.clear();
  setViewport("desktop");
});
window.scrollTo = () => {};
