// Vite+ per-package settings. The catalog's schemas and logic are pure and their suite runs in
// Node; the Durable Object mirror storage's suite runs in workerd (`vitest.worker.config.ts`). The
// two passes stay separate commands so one can replay from the task cache when only the other's
// inputs moved.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // Pure typechecks (the root tsconfig sets `noEmit`): the library, the Node-only seed
      // generator, and the workerd suite, each against its own runtime's types.
      build: { command: ["tsc", "tsc -p scripts", "tsc -p tsconfig.workerd.json"] },
    },
  },
}, ["vitest run", "vitest run -c vitest.worker.config.ts"]);
