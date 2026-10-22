// Vite+ per-package settings. The service logic is pure and its suite runs in Node; the Durable
// Object store's suite runs in workerd (`vitest.worker.config.ts`). The two passes stay separate
// commands so one can replay from the task cache when only the other's inputs moved.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`. The workerd suite is not part of it: the
      // Workers runtime's typings reject sources written to the web-standard surface (ADR-0009),
      // which the store and its parents are, so that suite is checked by running it.
      build: { command: "tsc" },
    },
  },
}, ["vitest run", "vitest run -c vitest.worker.config.ts"]);
