/// <reference types="vitest/config" />
// The district admin console. `pnpm --filter @schoolos/admin-ui dev` serves it with `/api` proxied
// to a harness district (`pnpm schoolos:harness`; Northfield is on :4801). Open it with one of the
// admin tokens the harness prints: `http://localhost:5183/?token=...`.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { withVitestTask } from "@gadgets/scripts/vitest-task";

// Production mode is set before Vite is imported, because Vite snapshots whether `NODE_ENV` was
// present before it loads this config. The Node launcher is shell-neutral.
const viteBuild = `node --input-type=module -e "process.env.NODE_ENV='production'; await (await import('vite')).build()"`;

// The path the app is served under. `/` unless SCHOOLOS_UI_BASE says otherwise: a deployment that
// serves several SchoolOS UIs from one origin gives each its own (scripts/production/
// assemble-district-ui.ts). The app routes by hash, so only its asset URLs depend on it.
const base = process.env.SCHOOLOS_UI_BASE ?? "/";
if (!/^\/([\w-]+\/)*$/.test(base)) throw new Error(`SCHOOLOS_UI_BASE must start and end with "/", not ${JSON.stringify(base)}`);

const tasks = withVitestTask({
  run: {
    tasks: {
      // The app's typecheck, the config's own, then the bundle, so a dependency the browser cannot
      // load fails the build rather than the first page view.
      build: {
        command: ["tsc", "tsc -p tsconfig.vite.json", viteBuild],
        cache: {
          env: ["VITE_*", "SCHOOLOS_ADMIN_API", "SCHOOLOS_UI_BASE"],
          input: [{ auto: true }, { pattern: "!dist/**", base: "package" } as const],
          output: ["dist/**"],
        },
      },
    },
  },
}, "vitest run");

export default defineConfig({
  // Spread: `run` is Vite+'s field, which vite's own `defineConfig` does not declare.
  ...tasks,
  base,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5183,
    proxy: { "/api": process.env.SCHOOLOS_ADMIN_API ?? "http://127.0.0.1:4801" },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    // The harness-backed suite boots and seeds a real district app.
    testTimeout: 30_000,
  },
});
