/// <reference types="vitest/config" />
// The EducateOS admin (SCHO-263): the SPA's Vite build, and the package's Vite+ tasks. The Worker's
// suite runs in workerd against a real D1 (`vitest.config.ts`); the SPA's in jsdom
// (`vitest.ui.config.ts`). `pnpm --filter @educateos/admin dev` serves the SPA on :5193.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { withVitestTask } from "@gadgets/scripts/vitest-task";

// Production mode is set before Vite is imported, because Vite snapshots whether `NODE_ENV` was
// present before it loads this config. The Node launcher is shell-neutral.
const viteBuild = `node --input-type=module -e "process.env.NODE_ENV='production'; await (await import('vite')).build()"`;

const tasks = withVitestTask({
  run: {
    tasks: {
      // The SPA's typecheck, the Worker's against the Workers types, the configs', then the bundle.
      build: {
        command: ["tsc", "tsc -p tsconfig.workerd.json", "tsc -p tsconfig.vite.json", viteBuild],
        cache: {
          env: [],
          input: [{ auto: true }, { pattern: "!dist/**", base: "package" } as const],
          output: ["dist/**"],
        },
      },
    },
  },
}, ["vitest run", "vitest run -c vitest.ui.config.ts"]);

export default defineConfig({
  // Spread: `run` is Vite+'s field, which vite's own `defineConfig` does not declare.
  ...tasks,
  plugins: [react(), tailwindcss()],
  server: { port: 5193 },
});
