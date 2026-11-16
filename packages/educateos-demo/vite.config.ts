/// <reference types="vitest/config" />
// The educateos.io demo (SCHO-224). `pnpm --filter @educateos/demo dev` serves it on :5190; it needs
// no harness, because the district runs in the page. The build writes straight into the site
// Worker's assets, at the path it is served from (`sites/educateos-io/public/demo/`, gitignored),
// so deploying the site after a build ships it.
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { withVitestTask } from "@gadgets/scripts/vitest-task";

const SITE_DIR = "sites/educateos-io/public/demo";

// Production mode is set before Vite is imported, because Vite snapshots whether NODE_ENV was set.
const viteBuild = `node --input-type=module -e "process.env.NODE_ENV='production'; await (await import('vite')).build()"`;

/**
 * The dev server serves a JSON import as a JavaScript module, but leaves a dynamic import's
 * `with: { type: "json" }` in place, so the browser refuses the module it gets back. That is how
 * `@educateos/harness` loads the sample course bundles (Node needs the attribute), and the
 * production build, which inlines them, is unaffected. Dropping the attribute in dev lets the
 * browser take Vite's module.
 */
const devJsonImports = (): Plugin => ({
  name: "educateos-demo:dev-json-imports",
  apply: "serve",
  enforce: "pre",
  transform(code, id) {
    if (id.includes("/node_modules/") || !code.includes("type: \"json\"")) return null;
    const stripped = code.replaceAll(/import\(\s*("[^"]+\.json")\s*,\s*\{\s*with:\s*\{\s*type:\s*"json"\s*\}\s*\}\s*\)/g, "import($1)");
    return stripped === code ? null : { code: stripped, map: null };
  },
});

const tasks = withVitestTask({
  run: {
    tasks: {
      // Type-checks the demo, the UIs it mounts and its scripts, then bundles them with the district app,
      // which is what proves every service behind the API runs in a browser.
      build: {
        command: ["tsc", "tsc -p tsconfig.vite.json", "tsc -p tsconfig.scripts.json", viteBuild],
        cache: { env: ["VITE_*"], input: [{ auto: true }], output: [{ pattern: `${SITE_DIR}/**`, base: "workspace" }] },
      },
    },
  },
}, "vitest run");

export default defineConfig({
  // Spread: `run` is Vite+'s field, which vite's own `defineConfig` does not declare.
  ...tasks,
  base: "/demo/",
  plugins: [devJsonImports(), react(), tailwindcss()],
  server: { port: 5190 },
  build: {
    outDir: `../../${SITE_DIR}`,
    // The directory is outside this package, so Vite will only empty it when told to.
    emptyOutDir: true,
    // The district application and the route schemas are most of the bundle, and every persona
    // needs all of it before its first screen, so splitting it would only add round trips.
    chunkSizeWarningLimit: 4096,
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["src/testSetup.ts"],
    // Each test boots and seeds a whole district.
    testTimeout: 60_000,
  },
});
