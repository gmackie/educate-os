// Test environment: React's act() around Testing Library's events, as @testing-library/react
// would install it, and stand-ins for the few browser APIs jsdom lacks that Kumo's Base UI
// primitives call. None changes what a test observes.
import { act } from "react";
import { configure } from "@testing-library/dom";

type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironment = globalThis as ActEnvironment;
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

configure({
  // Waiting (findBy*, user-event's delays) happens outside act, so React may commit in between.
  asyncWrapper: async (callback) => {
    const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const result = await callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return result;
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  },
  // Each event inside that wait is still one act() scope, as in @testing-library/react.
  eventWrapper: (callback) => {
    const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    let result: unknown;
    try {
      act(() => {
        result = callback();
      });
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
    return result;
  },
});

if (globalThis.PointerEvent === undefined) {
  // Base UI builds PointerEvents when a control is activated from the keyboard.
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {} as typeof globalThis.PointerEvent;
}
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
