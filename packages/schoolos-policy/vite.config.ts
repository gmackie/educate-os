// Vite+ per-package settings. The engine is pure and its suite runs in Node; the Durable Object
// audit sink's suite runs in workerd (`vitest.worker.config.ts`). The two passes stay separate
// commands so one can replay from the task cache when only the other's inputs moved.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`. The workerd suite has its own tsconfig,
      // because Node's and the Workers runtime's global types cannot share one program.
      build: { command: ["tsc", "tsc -p tsconfig.workerd.json"] },
    },
  },
}, ["vitest run", "vitest run -c vitest.worker.config.ts"]);
