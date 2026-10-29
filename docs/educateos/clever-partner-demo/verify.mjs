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
assert.equal(sections.length,12);
assert.equal(new Set(sections.map(section=>section.id)).size,12);
assert.equal(document.querySelectorAll("#jump option").length,12);
for (const image of document.querySelectorAll("img")) {
  assert(image.alt.length>20);
  await access(new URL(image.getAttribute("src"),import.meta.url));
}
for (const link of document.querySelectorAll("a[href]")) {
  assert(!link.getAttribute("href").startsWith("http"),"Meeting deck must be usable offline");
  await access(new URL(link.getAttribute("href"),import.meta.url));
}
document.querySelector("#present").click();
assert(document.body.classList.contains("presenting"));
document.querySelector("#next").click();
assert.equal(document.querySelector(".active").id,"platform");
document.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
assert.equal(document.querySelector(".active").id,"proof");
const jump=document.querySelector("#jump"); jump.value="11";
jump.dispatchEvent(new dom.window.Event("change"));
assert(document.querySelector("#next").disabled);
document.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
assert(!document.body.classList.contains("presenting"));
assert.deepEqual(errors,[]);
dom.window.close();
const evidence=JSON.parse(await readFile(new URL("./evidence.json",import.meta.url),"utf8"));
assert.equal(evidence.historicalGoogleAcceptance.science.returnedTotal,18);
assert.equal(evidence.cleverRecordedProbe.freshlyRetried,false);
assert(evidence.openAcceptance.length>0);
console.log("Meeting deck checks passed: 12 sections; all local images/downloads; accessible image text; presentation/keyboard navigation; print fallback source; evidence boundaries.");
