// Vite+ per-package settings. The stores, roster sync and admin service are tested in Node over the
// in-memory record table; the Durable Object table's suite runs in workerd
// (`vitest.worker.config.ts`), against real SQLite storage and concurrent requests.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // Pure typechecks (the root tsconfig sets `noEmit`): the library against the web-standard
      // surface, the Node tests, and the workerd suite against the Workers runtime's types.
      build: { command: ["tsc", "tsc -p __tests__", "tsc -p tsconfig.workerd.json"] },
    },
  },
}, ["vitest run", "vitest run -c vitest.worker.config.ts"]);
