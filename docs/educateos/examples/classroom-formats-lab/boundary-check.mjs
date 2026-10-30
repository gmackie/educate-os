import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs
  .readFileSync(new URL("./server.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replaceAll("export class", "class");
const Gadget = new Function(
  "DurableObject",
  "WorkerEntrypoint",
  "deckToPptx",
  src + ";return Gadget;",
)(
  class {
    constructor(state, env) {
      this.env = env;
    }
  },
  class {},
  () => {},
);
let reads = [];
const env = {
  SCIENCE: {
    getCourse: async () => ({ id: "895811762849", name: "Science" }),
    getCourseWork: async () => ({
      id: "work",
      title: "Task",
      description: "Learning goal: test. 1. Observe. 2. Explain. Success criteria: accuracy.",
      state: "PUBLISHED",
      pending: false,
    }),
    listRubrics: async () => {
      reads.push("rubrics");
      return [];
    },
    getRoster() {
      throw Error("Roster must never be read");
    },
    listSubmissions() {
      throw Error("Submissions must never be read");
    },
  },
};
const g = new Gadget({ storage: { get: async () => null } }, env);
const good = await g.fetchLesson("science");
assert.equal(good.parsed.steps.length, 2);
assert.deepEqual(reads, ["rubrics"]);
assert(!("roster" in good));
assert(!("submissions" in good));
for (const work of [{ state: "DRAFT" }, { state: "PUBLISHED", pending: true }]) {
  reads = [];
  env.SCIENCE.getCourseWork = async () => work;
  await assert.rejects(g.fetchLesson("science"), /not published/);
  assert.deepEqual(reads, []);
}
await assert.rejects(g.fetchLesson("unknown"), /Unknown class/);
console.log(
  "4 boundary scenarios passed: published projection, hidden draft, hidden pending, unknown class; no roster/submission reads.",
);
