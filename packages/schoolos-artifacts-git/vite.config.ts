// Vite+ per-package settings. Pure schemas and logic, so the suite runs in Node.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // Pure typechecks (the root tsconfig sets `noEmit`): the library on Node types, the smart HTTP
      // transport on the Workers types its gatekeeper-kit module needs.
      build: { command: "tsc -p tsconfig.json && tsc -p tsconfig.transport.json" },
    },
  },
}, "vitest run");
