// The test environment: no network at all, since the demo must never need it, plus what the mounted
// apps expect of a browser that jsdom lacks (as in the Learning Home's own setup).
import { act } from "react";
import { beforeEach, vi } from "vitest";
import { configure } from "@testing-library/dom";

beforeEach(() => {
  vi.stubGlobal("fetch", (input: unknown) => Promise.reject(new Error(`the demo fetched ${String(input)}`)));
});

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

window.scrollTo = () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
if (globalThis.PointerEvent === undefined) {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {} as typeof globalThis.PointerEvent;
}
