import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../packages/bundled-blueprints/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const source = await readFile(new URL("./index.html", import.meta.url),"utf8");
const errors=[];
const dom=new JSDOM(source,{runScripts:"dangerously",url:"https://demo.example/",beforeParse(window) {
  window.HTMLElement.prototype.scrollIntoView=function() {};
  window.print=function() {};
  window.addEventListener("error",event=>errors.push(event.message));
}});
const document=dom.window.document;
const sections=[...document.querySelectorAll(".slide")];
assert.equal(sections.length,16);
assert.equal(new Set(sections.map(section=>section.id)).size,16);
assert.equal(document.querySelectorAll("#jump option").length,16);
for (const image of document.querySelectorAll("img")) {
  assert(image.alt.length>20);
  await access(new URL(image.getAttribute("src"),import.meta.url));
}
for (const link of document.querySelectorAll("a[href]")) {
  assert(!link.getAttribute("href").startsWith("http"),"Meeting deck must be usable offline");
  const href=link.getAttribute("href");
  if(href==="district-demo.html") await access(new URL("./build-district-demo.mjs",import.meta.url));
  else await access(new URL(href,import.meta.url));
}
document.querySelector("#present").click();
assert(document.body.classList.contains("presenting"));
document.querySelector("#next").click();
assert.equal(document.querySelector(".active").id,"platform");
document.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
assert.equal(document.querySelector(".active").id,"district-product");
const jump=document.querySelector("#jump"); jump.value="15";
jump.dispatchEvent(new dom.window.Event("change"));
assert(document.querySelector("#next").disabled);
document.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
assert(!document.body.classList.contains("presenting"));
assert.deepEqual(errors,[]);
dom.window.close();
const bridge=new JSDOM(await readFile(new URL("./google-clever-bridge.html",import.meta.url),"utf8"),{runScripts:"dangerously"});
const mapping=JSON.parse(await readFile(new URL("./google-clever-bridge.json",import.meta.url),"utf8"));
assert.equal(mapping.items.length,12);
assert.equal(new Set(mapping.items.map(item=>item.id)).size,12);
for(const item of mapping.items) {
  for(const field of ["educateos","google","clever","boundary"])assert(item[field].length>40);
}
for(const filter of ["foundation","learning","operations","all"]) {
  bridge.window.document.querySelector(`[data-filter="${filter}"]`).click();
  const visible=[...bridge.window.document.querySelectorAll(".item")].filter(item=>!item.hidden);
  const expected=mapping.items.filter(item=>filter==="all"||item.layer===filter).length;
  assert.equal(visible.length,expected);
  assert.equal(bridge.window.document.querySelector("#count").textContent,`${expected} responsibilities`);
  assert.equal(bridge.window.document.querySelectorAll('[aria-pressed="true"]').length,1);
}
bridge.window.close();
const evidence=JSON.parse(await readFile(new URL("./evidence.json",import.meta.url),"utf8"));
assert.equal(evidence.historicalGoogleAcceptance.science.returnedTotal,18);
assert.equal(evidence.cleverRecordedProbe.freshlyRetried,false);
assert(evidence.openAcceptance.length>0);
assert.equal(evidence.meetingDeliverables.presentationSections,sections.length);
assert.equal(evidence.meetingDeliverables.providerResponsibilityTopics,mapping.items.length);
console.log("Meeting checks passed: 16 sections; local assets; accessible image text; presentation/keyboard navigation; 12 responsibility maps with layer filters; evidence boundaries.");
