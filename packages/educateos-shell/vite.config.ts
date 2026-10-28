// Vite+ per-package settings. A source-only React library: `build` type-checks it, and the suite
// runs in jsdom (vitest.config.ts).
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`.
      build: { command: "tsc" },
    },
  },
}, "vitest run");
