// Vite+ per-package settings. The whole suite runs in workerd (`vitest.config.ts`): the ledger is a
// SQLite Durable Object and Hall Monitor a fake Worker behind a real service binding.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`.
      build: { command: "tsc" },
    },
  },
}, "vitest run");
