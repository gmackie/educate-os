import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("./server.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/, "")
  .replace("export class Gadget", "class Gadget");
const Gadget = new Function("DurableObject", `${source}; return Gadget;`)(class {
  constructor(_state, env) { this.env = env; }
});
let work = [
  {id:"published", title:"Weathering", state:"PUBLISHED", teacherSecret:"excluded", materials:[
    {title:"Reading", kind:"link", url:"https://example.org/reading"},
    {title:"Unsafe", kind:"link", url:"javascript:alert(1)"},
  ]},
  {id:"draft", state:"DRAFT"},
];
let state = "CREATED", turns = 0, submissionReads = 0, failRead = false, rejectTurn = false;
const session = {
  async listCourseWork() { if (failRead) throw Error("Revoked"); return work; },
  async getMySubmission(id) {
    assert.equal(id, "published");
    submissionReads++;
    return {state, userId:"excluded", assignedGrade:18, draftGrade:19, answer:"My answer", attachments:[]};
  },
  async turnIn(id) {
    assert.equal(id, "published");
    if (rejectTurn) throw Error("Rejected");
    turns++; state = "TURNED_IN";
  },
};
const gadget = new Gadget({}, {
  GOOGLE_CLASSROOM_STUDENT: new Proxy(session, {get(target, name) {
    assert(name in target, `Unexpected authority requested: ${String(name)}`);
    return target[name];
  }}),
});
const list = await gadget.listAssignments();
assert.equal(list.assignments.length, 1);
assert(!("teacherSecret" in list.assignments[0]));
assert.equal(list.assignments[0].materials[1].url, undefined);
assert.equal(submissionReads, 0);
const own = await gadget.getAssignment("published");
assert.deepEqual(Object.keys(own.submission).toSorted(), ["alternateLink", "answer", "attachments", "late", "state"]);
for (const id of ["draft", "unknown", "other-course-work"]) {
  const before = submissionReads;
  await assert.rejects(gadget.getAssignment(id), /unavailable/);
  await assert.rejects(gadget.requestTurnIn(id), /unavailable/);
  assert.equal(submissionReads, before);
}
for (state of ["NEW", "TURNED_IN", "RETURNED", "SUBMISSION_STATE_UNSPECIFIED"]) {
  await assert.rejects(gadget.requestTurnIn("published"), /Prepare or reclaim/);
}
state = "CREATED"; rejectTurn = true;
await assert.rejects(gadget.requestTurnIn("published"), /Rejected/);
assert.equal(state, "CREATED"); assert.equal(turns, 0);
rejectTurn = false;
assert.equal((await gadget.requestTurnIn("published")).submission.state, "TURNED_IN");
await assert.rejects(gadget.requestTurnIn("published"), /Prepare or reclaim/);
assert.equal(turns, 1);
state = "RECLAIMED_BY_STUDENT";
assert.equal((await gadget.requestTurnIn("published")).submission.state, "TURNED_IN");
failRead = true;
await assert.rejects(gadget.getAssignment("published"), /Revoked/);
await assert.rejects(gadget.requestTurnIn("published"), /Revoked/);
assert.equal(turns, 2);
console.log("Student companion boundaries passed: published-only projection; own-work fields; unsafe links; unknown/draft/other work denial; state guards; rejection; committed readback; repeat/reclaimed turn-in; revoked reads/writes. Provider identity isolation is tested separately by the connector.");
