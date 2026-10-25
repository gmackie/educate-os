// Vite+ per-package settings. Pure logic over injected storage and a Content Studio, so the suite
// runs in Node.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // Pure typechecks (the root tsconfig sets `noEmit`): the library against the web-standard surface,
      // then the tests and fixture generator, which also need Node types to read and write fixtures.
      build: { command: "tsc && tsc -p __tests__" },
    },
  },
}, "vitest run");
