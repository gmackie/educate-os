// Vite+ per-package settings. The whole suite runs in workerd (`vitest.config.ts`): the district is
// a SQLite Durable Object, reached through the Worker's own fetch handler and entrypoints.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`.
      build: { command: "tsc" },
    },
  },
}, "vitest run");
