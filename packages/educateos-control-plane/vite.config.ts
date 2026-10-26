// Vite+ per-package settings. The whole suite runs in workerd (`vitest.config.ts`): the store is a
// SQLite Durable Object, reached through the site Worker's own fetch handler.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`. The Workers shell, the site Worker that
      // composes it and the suite have their own tsconfig, against the Workers runtime's types.
      build: { command: ["tsc", "tsc -p tsconfig.workerd.json"] },
    },
  },
}, "vitest run");
