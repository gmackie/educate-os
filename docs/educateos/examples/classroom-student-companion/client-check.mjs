import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../../packages/bundled-blueprints/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {url:"https://gadget.example/"});
const document = dom.window.document;
let requests = 0, failed = false, reject = false;
const assignment = {id:"work",title:"<img src=x onerror=alert(1)>",description:"Read and explain.",materials:[]};
const data = () => ({assignment, fetchedAt:"2026-10-29T00:00:00Z", submission:{state: requests ? "TURNED_IN" : "CREATED",attachments:[]}});
const gadget = {
  async listAssignments() { if (failed) throw Error("Revoked"); return {assignments:[assignment]}; },
  async getAssignment() { return data(); },
  async requestTurnIn() { if (reject) throw Error("Rejected"); requests++; return data(); },
};
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
await new AsyncFunction("document", "gadget", await readFile(new URL("./client.js", import.meta.url), "utf8"))(document,gadget);
assert.equal(document.querySelector("h2").textContent, assignment.title);
assert.equal(document.querySelector("img"), null);
const buttons = () => [...document.querySelectorAll("button")];
const submit = () => buttons().find((button) => button.textContent === "Request turn-in approval");
assert(submit().disabled);
function confirm() {
  const input = document.querySelector("input"); input.checked = true;
  input.dispatchEvent(new dom.window.Event("change"));
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
confirm(); assert(!submit().disabled); reject = true; submit().click(); await settle();
assert.equal(requests, 0);
assert.match(document.body.textContent, /not confirmed/);
document.querySelector("header button").click(); await settle();
assert(submit().disabled); reject = false; confirm(); submit().click(); await settle();
assert.equal(requests, 1); assert.match(document.body.textContent, /Google confirms/);
assert.equal(submit(), undefined);
failed = true; document.querySelector("header button").click(); await settle();
assert.match(document.body.textContent, /Unable to read/);
assert.equal(document.querySelector("article"), null);
dom.window.close();
console.log("Student client fixture checks passed: text rendering, confirmation guard, rejection recovery, committed turn-in and revoked-content clearing.");
