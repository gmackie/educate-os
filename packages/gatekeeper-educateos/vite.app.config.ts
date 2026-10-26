// The School app (SCHO-218): the district's admin console, Teacher Studio and Learning Home, built
// as one inlined HTML file that the account's startAppUi() hands the Workshop to host in its
// network-isolated frame. `node build-app.ts` runs this and writes src/generated/app.txt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const pkgDir = dirname(fileURLToPath(import.meta.url));

// `--watch` drives the `pnpm dev-server` hot loop; `build:app:dev` builds the same bytes once.
const isWatch = process.argv.includes("--watch");
const unminified = isWatch || process.env.GATEKEEPER_APP_UNMINIFIED === "true";

// Writes the inlined build where the Worker imports it from, skipping identical rewrites, which
// would otherwise loop wrangler's watcher.
const emitAppText = (): Plugin => ({
  name: "emit-app-text",
  closeBundle() {
    const html = readFileSync(resolve(pkgDir, "dist-app", "app", "index.html"), "utf8");
    const outFile = resolve(pkgDir, "src", "generated", "app.txt");
    const contents = `<!-- Generated from packages/gatekeeper-educateos/app by build-app.ts. Do not edit. -->\n${html}`;
    if (existsSync(outFile) && readFileSync(outFile, "utf8") === contents) {
      console.log(`app.txt unchanged (${(html.length / 1024).toFixed(0)} KiB), skipping write`);
      return;
    }
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, contents);
    console.log(`wrote ${outFile} (${(html.length / 1024).toFixed(0)} KiB)`);
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), emitAppText()],
  build: {
    outDir: "dist-app",
    emptyOutDir: true,
    minify: unminified ? false : "terser",
    terserOptions: { compress: { passes: 2 }, format: { comments: false } },
    // Network-isolated frame: no separate asset files.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { input: "app/index.html", output: { entryFileNames: "gatekeeper-educateos.js" } },
    watch: isWatch ? { exclude: ["**/node_modules/**", "**/dist-app/**", "**/.wrangler/**", "**/generated/**"] } : undefined,
  },
});
