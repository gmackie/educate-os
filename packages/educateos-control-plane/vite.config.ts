// Vite+ per-package settings. Most of the suite runs in workerd (`vitest.config.ts`): the store is a
// SQLite Durable Object, reached through the site Worker's own fetch handler. The guided install's
// suite runs in Node (`vitest.node.config.ts`), against the installer's Cloudflare fake.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`. The Workers shell, the site Worker that
      // composes it and the suite have their own tsconfig, against the Workers runtime's types.
      build: { command: ["tsc", "tsc -p tsconfig.workerd.json", "tsc -p tsconfig.node.json"] },
    },
  },
}, ["vitest run", "vitest run -c vitest.node.config.ts"]);
