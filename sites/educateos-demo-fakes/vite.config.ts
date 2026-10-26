// Vite+ per-package settings. The suite runs in workerd (`vitest.config.ts`): each district's fakes
// are a real SQLite Durable Object, reached through the Worker's own fetch handler.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`.
      build: { command: "tsc" },
    },
  },
}, "vitest run");
