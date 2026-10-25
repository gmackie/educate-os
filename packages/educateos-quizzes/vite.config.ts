// Vite+ per-package settings. Pure logic over injected storage, course content and grading
// ports, so the suite runs in Node.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`.
      build: { command: "tsc" },
    },
  },
}, "vitest run");
