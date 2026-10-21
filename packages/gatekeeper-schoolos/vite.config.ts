// Vite+ per-package settings. `test` runs two vitest projects -- the session and the district
// service in Node, the Worker's connect flow and facet in workerd -- as separate commands.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`.
      build: { command: "tsc" },
    },
  },
}, ["vitest run", "vitest run -c vitest.worker.config.ts"]);
