import { cp, mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const source = fileURLToPath(new URL(".", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(process.argv[2] || "/tmp/educateos-clever-demo");
const archive = output + ".zip";
try { await access(archive); throw Error(`Archive already exists: ${archive}. Choose a fresh output path.`); }
catch (error) { if (error.code !== "ENOENT") throw error; }
// Refuse an existing destination rather than recursively deleting user files.
await mkdir(output);
const kit = "docs/educateos/clever-partner-demo";
await mkdir(join(output, "docs/educateos"), {recursive:true});
await cp(source, join(output,kit), {recursive:true});
for (const path of [
  "docs/educateos/examples/classroom-student-companion",
  "docs/educateos/examples/classroom-formats-lab",
  "docs/educateos/runbooks/classroom-verification.md",
  "docs/educateos/runbooks/classroom-customer-demo.md",
  "docs/blueprints.md",
]) {
  await mkdir(resolve(output,path,".."), {recursive:true});
  await cp(resolve(repository,path),resolve(output,path),{recursive:true});
}
// The meeting deck works offline as one HTML file; download links stay next to it.
const html = (await readFile(join(source,"index.html"),"utf8"))
  .replace(/src="assets\/([^"/]+\.jpg)"/g, (_match,name) => {
    // Embedded below after reads; no network dependency is introduced.
    return `src="__IMAGE_${name}__"`;
  });
let standalone = html;
for (const name of (await readdir(join(source,"assets"))).filter((name) => name.endsWith(".jpg"))) {
  standalone = standalone.replaceAll(`__IMAGE_${name}__`, `data:image/jpeg;base64,${(await readFile(join(source,"assets",name))).toString("base64")}`);
}
await writeFile(join(output,"index.html"),standalone);
await cp(join(source,"google-clever-bridge.html"),join(output,"google-clever-bridge.html"));
await cp(join(source,"full-system-demo.md"),join(output,"full-system-demo.md"));
const districtBuild=spawnSync(process.execPath,[join(source,"build-district-demo.mjs"),join(output,"district-demo.html")],{cwd:repository,encoding:"utf8"});
if(districtBuild.status!==0)throw Error(`District demo build failed: ${districtBuild.stderr}`);
const districtCheck=spawnSync(process.execPath,[join(source,"district-demo-check.mjs"),join(output,"district-demo.html")],{cwd:repository,encoding:"utf8"});
if(districtCheck.status!==0)throw Error(`District demo execution failed: ${districtCheck.stderr}`);
await mkdir(join(output,"assets"));
for (const name of (await readdir(join(source,"assets"))).filter((name) => /\.(pdf|pptx)$/.test(name))) {
  await cp(join(source,"assets",name),join(output,"assets",name));
}
await writeFile(join(output,"README.txt"), "EducateOS x Clever full-system meeting kit\n\nOpen index.html locally; no server or internet is needed.\nOpen district-demo.html to try the actual EducateOS student/teacher/guardian/admin applications over a synthetic district; no real SSO/provider/AI. Switch persona in the same tab to keep work. Reset/reload discards district state.\nOpen google-clever-bridge.html for the detailed provider responsibility comparison.\nSee full-system-demo.md for the 30-minute product and connected-Google demonstration script.\nSee docs/educateos/clever-partner-demo/README.md for evidence, prompts and rehearsal steps.\nGoogle assets are historical synthetic-account snapshots from 2026-10-28, not new live results.\nPersonal student companion source is included; live EducateOS learner OAuth/turn-in remains open.\nSource files require Workshop install/review and each user's own bindings, not direct .gadget import.\nFull Google validation remains in progress (SCHO-255).\n");
const builtTeacher = join(output,"gadgets/classroom-formats-lab");
const build = spawnSync(process.execPath,[resolve(repository,"docs/educateos/examples/classroom-formats-lab/build.mjs"),builtTeacher],{cwd:repository,encoding:"utf8"});
if (build.status!==0) throw Error(`Teacher gadget build failed: ${build.stderr}`);
await mkdir(join(output,"gadgets/classroom-student-companion"),{recursive:true});
for (const name of ["server.js","client.js"]) await cp(resolve(repository,"docs/educateos/examples/classroom-student-companion",name),join(output,"gadgets/classroom-student-companion",name));
await writeFile(join(output,"gadgets/README.txt"),"Install each folder's server.js and client.js through a new Workshop gadget's Code editor, review and accept.\nTeacher Formats Lab requires SCIENCE and ALGEBRA course bindings as described in its source README.\nStudent companion requires only GOOGLE_CLASSROOM_STUDENT in a separate student's own workspace.\nEach account must grant its own resources. These are installable source files, not .gadget archives.\nPublish reviewed committed code through the existing blueprint UI and validate fresh personal copies.\n");
async function files(directory, prefix="") {
  const result=[];
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const relative=prefix+entry.name;
    if (entry.isDirectory()) result.push(...await files(join(directory,entry.name),relative+"/"));
    else if (entry.isFile()) result.push(relative);
  }
  return result.toSorted();
}
const paths=await files(output);
const checksums=[];
for (const path of paths) checksums.push(`${createHash("sha256").update(await readFile(join(output,path))).digest("hex")}  ${path}`);
await writeFile(join(output,"SHA256SUMS"),checksums.join("\n")+"\n");
const zipped=spawnSync("zip",["-q","-r",archive,"."],{cwd:output,encoding:"utf8"});
if (zipped.status!==0) throw Error(`ZIP failed: ${zipped.stderr}`);
console.log(JSON.stringify({output,archive,files:paths.length+1,externalUploads:0},null,2));
