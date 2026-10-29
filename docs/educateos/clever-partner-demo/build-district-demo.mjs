// Build the existing district demo unchanged, then inline its assets for offline use.
import { build } from "vite";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(),"educateos-district-demo-"));
try {
  await build({
    root: resolve(repository,"packages/educateos-demo"),
    configFile: resolve(repository,"packages/educateos-demo/vite.config.ts"),
    base: "./",
    logLevel: "error",
    build: {outDir:directory,emptyOutDir:true},
  });
  let html=await readFile(join(directory,"index.html"),"utf8");
  // Insert before bundling: compiled code can itself contain HTML body tags in strings.
  html=html.replace(/<body([^>]*)>/,'<body$1><aside style="padding:10px 16px;border-bottom:1px solid currentColor;font:14px/1.5 system-ui"><b>Offline EducateOS product demo.</b> Synthetic Northfield data; Google and Clever are not connected here. AI is off. Changes last only until reset/reload. <a href="index.html">Back to the meeting presentation</a>.</aside>');
  for (const match of html.matchAll(/<script type="module" crossorigin src="([^"]+)"><\/script>/g)) {
    const script=await readFile(resolve(directory,match[1]),"utf8");
    if (/\bimport\s*\(|\bimport\.meta/.test(script)) throw Error("Offline demo cannot depend on dynamic module loading.");
    html=html.replace(match[0],()=>`<script type="module">${script.replaceAll("</script","<\\/script")}</script>`);
  }
  for (const match of html.matchAll(/<link rel="stylesheet" crossorigin href="([^"]+)">/g)) {
    const css=await readFile(resolve(directory,match[1]),"utf8");
    html=html.replace(match[0],()=>`<style>${css}</style>`);
  }
  const output=resolve(process.argv[2] || "/tmp/educateos-district-demo.html");
  await writeFile(output,html);
  console.log(`Offline district applications written to ${output}`);
} finally {
  await rm(directory,{recursive:true,force:true});
}
