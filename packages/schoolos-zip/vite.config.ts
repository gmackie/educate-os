// Vite+ per-package settings. Pure logic over bytes, so the suite runs in Node.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // Pure typechecks (the root tsconfig sets `noEmit`): the library against the web-standard
      // surface, then the tests, which also need Node types.
      build: { command: "tsc && tsc -p __tests__" },
    },
  },
}, "vitest run");
