// Vite+ per-package settings. The release logic is pure and its suite runs in Node; the Durable
// Object stores' suite runs in workerd (`vitest.worker.config.ts`). The two passes stay
// separate commands so one can replay from the task cache when only the other's inputs moved.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`. The workerd suite has its own tsconfig,
      // because it is checked against the Workers runtime's types (ADR-0009).
      build: { command: ["tsc", "tsc -p tsconfig.workerd.json"] },
    },
  },
}, ["vitest run", "vitest run -c vitest.worker.config.ts"]);
