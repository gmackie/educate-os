// The Student Learning Home's Vite config, and its Vite+ tasks. `pnpm dev` serves the SPA on :5181
// and proxies `/api` to a harness district (Northfield on :4801 unless EDUCATEOS_DISTRICT_URL says
// otherwise); sign in with `?token=<a student token the harness printed>`.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { withVitestTask } from "@gadgets/scripts/vitest-task";

// `dist/` is this package's own output: vp declines to cache a task that reads a path it also wrote.
const ownDist = { pattern: "!dist/**", base: "package" } as const;
// Production mode is set before Vite is imported, because Vite snapshots whether NODE_ENV was set.
const viteBuild = `node --input-type=module -e "process.env.NODE_ENV='production'; await (await import('vite')).build()"`;

const tasks = withVitestTask({
  run: {
    tasks: {
      // Type-checks the app and its config, then bundles it, which is what proves the SPA's
      // dependencies (the API client and the route schemas behind it) are browser-safe.
      build: {
        command: ["tsc", "tsc -p tsconfig.vite.json", viteBuild],
        cache: { env: ["VITE_*"], input: [{ auto: true }, ownDist], output: ["dist/**"] },
      },
    },
  },
}, "vitest run");

export default defineConfig({
  // Spread: `run` is Vite+'s field, which vite's own `defineConfig` does not declare.
  ...tasks,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5181,
    proxy: { "/api": process.env.EDUCATEOS_DISTRICT_URL ?? "http://127.0.0.1:4801" },
  },
});
