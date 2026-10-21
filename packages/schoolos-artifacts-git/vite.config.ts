// Vite+ per-package settings. Pure schemas and logic, so the suite runs in Node.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // Pure typechecks (the root tsconfig sets `noEmit`): the library against the web-standard
      // surface, the tests with Node's typings added, and the smart HTTP transport on the Workers
      // types its gatekeeper-kit module needs.
      build: { command: "tsc && tsc -p __tests__ && tsc -p tsconfig.transport.json" },
    },
  },
}, "vitest run");
