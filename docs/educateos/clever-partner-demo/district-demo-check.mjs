// Execute the actual compiled applications in a DOM with all fetches refused.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
const require=createRequire(new URL("../../../packages/bundled-blueprints/package.json",import.meta.url));
const {JSDOM,VirtualConsole}=require("jsdom");
const html=await readFile(process.argv[2],"utf8");
const source=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert(source,"The offline district bundle must be present");
const errors=[],requests=[];
const virtualConsole=new VirtualConsole();
// jsdom 26 cannot parse Tailwind 4's modern CSS; layout is inspected with html_preview.
virtualConsole.on("jsdomError",error=>{if(error.type!=="css parsing")errors.push(error.message);});
virtualConsole.on("error",(...values)=>errors.push(values.map(String).join(" ")));
// jsdom 26 compares file URL path arrays by identity in History-impl.js, rejecting even the
// unchanged URL. Use a virtual HTTPS origin for DOM execution; this is not file-browser proof.
const dom=new JSDOM(html,{url:"https://offline-demo.example/",runScripts:"outside-only",pretendToBeVisual:true,virtualConsole});
const window=dom.window;
window.addEventListener("error",event=>errors.push(event.message));
assert(window.document.querySelector("body > aside"),"Offline notice must be in the actual page body");
assert.equal(window.document.querySelectorAll('script[src],link[rel="stylesheet"][href]').length,0,"All application assets must be inline");
Object.defineProperty(window,"crypto",{value:webcrypto});
for (const key of ["Request","Response","Headers","TextEncoder","TextDecoder","structuredClone","ReadableStream","WritableStream","TransformStream","CompressionStream","DecompressionStream"]) window[key]=globalThis[key];
window.fetch=(input)=>{requests.push(String(input));return Promise.reject(Error("Offline demo attempted a network request"));};
window.scrollTo=()=>{};
window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
window.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}};
window.PointerEvent=window.MouseEvent;
window.eval(source);
async function waitFor(predicate,label) {
  const deadline=Date.now()+30000;
  while(Date.now()<deadline) {
    if(predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error(`Timed out waiting for ${label}; errors: ${errors.join("; ")}: ${window.document.body.textContent.slice(-1200)}`);
}
const button=(prefix)=>[...window.document.querySelectorAll("button")].find(node=>node.textContent.trim().startsWith(prefix));
const link=(prefix)=>[...window.document.querySelectorAll("a")].find(node=>node.textContent.trim().startsWith(prefix));
const bodyHas=(text)=>window.document.body.textContent.includes(text);
const fill=(field,value)=>{
  const prototype=field.tagName==="TEXTAREA"?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,"value").set.call(field,value);
  field.dispatchEvent(new window.Event("input",{bubbles:true}));
};
const labelled=(label)=>{
  const element=[...window.document.querySelectorAll("label")].find(node=>node.textContent.trim()===label);
  assert(element,`Missing field: ${label}`);
  return window.document.getElementById(element.htmlFor);
};
async function follow(prefix) {
  await waitFor(()=>link(prefix),`link ${prefix}`);
  link(prefix).click();
}
async function choose(role,heading) {
  button("Switch persona").click();
  await waitFor(()=>button(role),role);
  button(role).click();
  await waitFor(()=>bodyHas(heading),heading);
}
try {
  await waitFor(()=>button("Grade 9 student"),"persona picker");
  button("Grade 9 student").click();
  await waitFor(()=>window.document.body.textContent.includes("Hi, Amara Okafor"),"student home");
  if(process.argv[3]) await writeFile(process.argv[3],dom.serialize().replace(/<script type="module">[\s\S]*?<\/script>/,""));
  await follow("English 9 · Period 3");
  await follow("Reading reflection");
  const activityHash=window.location.hash;
  await waitFor(()=>window.document.querySelector("textarea"),"reflection editor");
  const reflection="I read about school gardens. Observation connects an everyday place to a science investigation.";
  fill(window.document.querySelector("textarea"),reflection);
  await waitFor(()=>button("Save")&&!button("Save").disabled,"enabled Save");
  button("Save").click();
  await waitFor(()=>button("Submit")&&!button("Submit").disabled,"saved reflection");
  button("Submit").click();
  await waitFor(()=>window.document.querySelector('[role="dialog"] button'),"submission confirmation");
  [...window.document.querySelectorAll('[role="dialog"] button')].find(node=>node.textContent.trim()==="Submit").click();
  await waitFor(()=>bodyHas("Receipt code"),"submission receipt");
  button("Done").click();
  await choose("English 9 teacher","My classes");
  await follow("English 9 · Period 3");
  await follow("Submissions");
  await follow("Reading reflection");
  await follow("Review Amara Okafor");
  await waitFor(()=>bodyHas(reflection)&&button("Add comment"),"teacher reading submitted revision");
  const comment="Clear reflection. Add a quotation to support the connection.";
  fill(labelled("Comment"),comment);
  await waitFor(()=>!button("Add comment").disabled,"enabled comment");
  button("Add comment").click();
  await waitFor(()=>window.document.querySelector('[aria-labelledby="feedback-heading"]').textContent.includes(comment),"recorded feedback");
  fill(labelled("Points"),"4");
  fill(labelled("Out of"),"5");
  await waitFor(()=>!button("Approve official grade").disabled,"enabled grade approval");
  button("Approve official grade").click();
  await waitFor(()=>button("Yes, approve official grade"),"official grade confirmation");
  button("Yes, approve official grade").click();
  await waitFor(()=>bodyHas("4 out of 5"),"official teacher grade");
  button("Share feedback with student").click();
  await waitFor(()=>bodyHas("Shared with the student"),"released feedback");
  await choose("Grade 9 student","Hi, Amara Okafor");
  window.location.hash=activityHash;
  await waitFor(()=>bodyHas(comment)&&bodyHas("Official grade: 4 out of 5"),"learner released feedback and grade");
  await choose("Amara's guardian","Amara Okafor's classes");
  await follow("English 9 · Period 3");
  await waitFor(()=>bodyHas(comment)&&bodyHas("Official grade: 4 of 5 points"),"guardian released result");
  assert(!bodyHas(reflection),"Guardian must not receive the student's submitted artifact");
  await choose("District administrator","Dashboard");
  button("Reset demo").click();
  await waitFor(()=>button("Grade 9 student"),"reset picker");
  assert.deepEqual(requests,[]);
  assert.deepEqual(errors,[]);
  console.log("Offline compiled district demo passed: four real persona applications; saved reflection, receipt, teacher comment/official 4/5 approval/release, learner and guardian readback; guardian artifact isolation; reset; inline assets and zero network fetches. DOM execution uses a virtual HTTPS origin, not a file browser.");
} finally {window.close();}
