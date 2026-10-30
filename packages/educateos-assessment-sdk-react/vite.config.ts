import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: { tasks: { build: { command: "tsc" } } },
}, "vitest run");
