// Vite+ per-package settings. Pure identity logic over the contracts, so the suite runs in Node.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // Pure typechecks (the root tsconfig sets `noEmit`): the library, then the Node-only SCHO-37
      // comparison CLI, which has its own tsconfig because it needs Node types.
      build: { command: "tsc && tsc -p scripts" },
    },
  },
}, "vitest run");
