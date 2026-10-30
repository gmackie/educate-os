import { build } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";

const directory = fileURLToPath(new URL(".", import.meta.url));
const output = resolve(process.argv[2] || "/tmp/educateos-classroom-formats-lab");
await build({
  configFile: false,
  build: {
    outDir: output,
    emptyOutDir: false,
    minify: false,
    lib: { entry: resolve(directory, "server.js"), formats: ["es"], fileName: () => "server.js" },
    rollupOptions: { external: ["cloudflare:workers"] },
  },
  resolve: {
    alias: {
      "@gadgets/bundled-blueprints/libraries/zip/server": fileURLToPath(
        new URL("../../../../packages/bundled-blueprints/libraries/zip/server.ts", import.meta.url),
      ),
    },
  },
});
await mkdir(output, { recursive: true });
await copyFile(resolve(directory, "client.js"), resolve(output, "client.js"));
console.log(`Workshop files written to ${output}`);
