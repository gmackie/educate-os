// Teacher Studio: a Vite React SPA. `pnpm dev` serves it on :4811 and proxies `/api` to a harness
// district (Northfield on :4801 by default; SCHOOLOS_DISTRICT_URL overrides it).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { withVitestTask } from "@gadgets/scripts/vitest-task";

const district = process.env.SCHOOLOS_DISTRICT_URL ?? "http://127.0.0.1:4801";

export default defineConfig(withVitestTask({
  run: {
    tasks: {
      // A typecheck, then the production bundle, so a route schema that cannot run in a browser
      // fails the build rather than the first teacher.
      build: {
        command: ["tsc", "vite build"],
        cache: { input: [{ auto: true }, { pattern: "!dist/**", base: "package" }], output: ["dist/**"] },
      },
    },
  },
  plugins: [react(), tailwindcss()],
  server: { port: 4811, proxy: { "/api": district } },
  // The client validates every response with the district's own route schemas, which is most of
  // the bundle; splitting them would only move the same bytes into a chunk every screen loads.
  build: { chunkSizeWarningLimit: 1024 },
}, "vitest run"));
