#!/usr/bin/env node
// Bundles the CLI and everything it imports (the installer library, its workspace packages and
// zod) into one self-contained ES module, so `npx launch-educate-os` needs no workspace, no
// TypeScript support in Node and no runtime dependencies.
//
//   node scripts/bundle.ts [--out <file>]     default: dist/launch-educate-os.mjs
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Bundles the CLI to `outfile` and returns its path. */
export async function bundle(outfile = resolve(root, "dist/launch-educate-os.mjs")): Promise<string> {
  const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(root, "src/bin.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Node's own modules stay imports; everything else is inlined.
    packages: "bundle",
    banner: {
      // Some bundled CommonJS expects `require`; give it Node's, scoped to this file.
      js: "#!/usr/bin/env node\nimport { createRequire as __launchCreateRequire } from 'node:module';\nconst require = __launchCreateRequire(import.meta.url);",
    },
    define: { __LAUNCH_VERSION__: JSON.stringify(version) },
    legalComments: "eof",
    logLevel: "warning",
  });
  chmodSync(outfile, 0o755);
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  console.log(await bundle(values.out ? resolve(values.out) : undefined));
}
