// Vite+ per-package settings. Pure logic over an injected package source, so the main suite runs in
// Node; the Durable Object library's suite runs in workerd (`vitest.worker.config.ts`). The two
// passes stay separate commands so one can replay from the task cache when only the other's inputs
// moved.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`. The workerd suite has its own tsconfig,
      // because the Workers runtime's global types and the DOM library cannot share one program.
      build: { command: ["tsc", "tsc -p tsconfig.workerd.json"] },
    },
  },
}, ["vitest run", "vitest run -c vitest.worker.config.ts"]);
