// Vite+ per-package settings. `build` type-checks and then bundles the CLI into
// dist/launch-educate-os.mjs, the one file the npm package ships. The end-to-end suite bundles its
// own copy into a temporary directory, so the tests need no build first.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      build: { command: ["tsc", "node scripts/bundle.ts"] },
    },
  },
}, "vitest run");
