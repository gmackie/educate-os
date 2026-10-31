import { withVitestTask } from "@gadgets/scripts/vitest-task";
/**
 * Two commands, not one `&&` string: the shared wrapper adds its watchdog and flags per command, so
 * a chain left the first `vitest run` without `--no-fsModuleCache` (it then wrote the shared
 * `node_modules/.vitest-cache` and never cached) and the second without the watchdog.
 */
export default withVitestTask({ run: { tasks: { build: { command: "tsc" } } } }, ["vitest run", "vitest run --config vitest.worker.config.ts"]);
