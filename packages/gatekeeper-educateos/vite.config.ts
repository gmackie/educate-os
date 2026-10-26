// Vite+ per-package settings. `test` runs two vitest projects -- the session, the district service
// and the School app frame in Node, the Worker's connect flow, facet and app in workerd -- as
// separate commands. The School app's own build config is `vite.app.config.ts`; Vite+ reads
// per-package settings only from `vite.config.*`, so the two cannot share a file.
import { defineConfig } from "vite-plus";
import { vitestTask } from "@gadgets/scripts/vitest-task";

// `build:app` writes `dist-app/` and `src/generated/app.txt` back into the package, so they are
// excluded from its own fingerprint, workspace-wide as gatekeeper-context's explains.
const APP_INPUT = [
  { auto: true },
  { pattern: "!**/dist-app/**", base: "workspace" },
  { pattern: "!**/src/generated/**", base: "workspace" },
  { pattern: "!**/.wrangler/**", base: "workspace" },
] as const;

export default defineConfig({
  run: {
    tasks: {
      // The Worker imports the app's HTML, so it does not typecheck without it. Its tests embed a stub.
      build: { command: ["tsc -p tsconfig.app.json", "tsc -p tsconfig.vite.json", "tsc"], dependsOn: ["build:app"] },
      test: vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts"]),
      "build:app": {
        command: "node build-app.ts",
        cache: { input: [...APP_INPUT], output: ["dist-app/**", "src/generated/app.txt"] },
      },
      // The same build unminified, for the `pnpm dev-server` pre-flight (see gatekeeper-context).
      "build:app:dev": {
        command: "node build-app.ts --dev",
        cache: { input: [...APP_INPUT], output: ["src/generated/app.txt"] },
      },
    },
  },
});
