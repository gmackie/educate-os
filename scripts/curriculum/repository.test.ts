// The repository's own curriculum (SCHO-330): it passes the check CI runs, and the reference
// course holds the semester the authoring guide describes. Only reads the tree; the copy it checks
// is made under the OS temp directory.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { NORTHFIELD_SHOWCASE } from "../../packages/educateos-fixtures/src/showcase/index.ts";
import { checkTree, CURRICULUM_ROOT, type Issue, readTree, validateTree } from "./lib.ts";

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const errors = (issues: readonly Issue[]) => issues.filter((issue) => issue.severity === "error");
const messages = (issues: readonly Issue[]) => errors(issues).map((issue) => `${issue.where}: ${issue.message}`).join("\n");

describe("the repository's curriculum", () => {
  it("passes check: valid, packed, and signed by the educateos.io publisher key", async () => {
    const result = await checkTree(readTree());
    assert.deepEqual(errors(result.issues), [], messages(result.issues));
  });

  it("holds Grade 1 Reading Foundations: a semester whose first units are the showcase's", async () => {
    const { reports } = await validateTree(readTree());
    const course = reports.find((report) => report.id === "educateos.io/grade-1-reading-foundations");
    assert.ok(course);
    assert.equal(course.units.length, 6);
    const showcase = NORTHFIELD_SHOWCASE.courses.find((c) => c.offeringId === "off_nf-g1read-fall-r7")!;
    assert.deepEqual(course.units.slice(0, 2).map((unit) => unit.title), showcase.modules.map((module) => module.title));
    for (const unit of course.units) {
      assert.ok(unit.activities.lesson.length >= 1 && unit.activities.assessment.length === 1, unit.title);
      assert.ok(unit.activities.assignment.length >= 1 && unit.activities.assignment.length <= 2, unit.title);
      assert.deepEqual(unit.notes, { students: 1, teacher: 1, answerKeys: 1 }, unit.title);
    }
    assert.ok(course.units[0]!.activities.assignment.includes("Word Builders"));
    assert.ok(course.units[1]!.activities.assignment.includes("Retell The Little Seed"));
  });

  it("can be copied and still checks, so the check reads only the tree it is given", async () => {
    const root = mkdtempSync(join(tmpdir(), "curriculum-copy-"));
    temps.push(root);
    cpSync(CURRICULUM_ROOT, root, { recursive: true });
    assert.deepEqual(errors((await checkTree(readTree(root))).issues), []);
  });
});
