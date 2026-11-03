import { describe, expect, it } from "vitest";
import { NORTHFIELD, NORTHFIELD_GUARDIANS, NORTHFIELD_SHOWCASE, SHOWCASE_BANDS, SHOWCASE_STAGES, rubricMaxPoints } from "../src/index.ts";

const { courses, resources } = NORTHFIELD_SHOWCASE;
const active = new Set(NORTHFIELD.terms.filter((t) => t.state === "active").map((t) => t.id));

function enrolled(offeringId: string, role: "student" | "teacher") {
  return NORTHFIELD.enrollments.filter((e) => e.offeringId === offeringId && e.role === role && e.status === "active").map((e) => e.principalId);
}

describe.each(courses.map((c) => [c.offeringId, c] as const))("the showcase class %s", (_, course) => {
  const offering = NORTHFIELD.offerings.find((o) => o.id === course.offeringId)!;
  const students = new Set(enrolled(course.offeringId, "student"));

  it("is an active Northfield class taught by its author, with at least two students", () => {
    expect(offering).toBeDefined();
    expect(active.has(offering.termId)).toBe(true);
    expect(enrolled(course.offeringId, "teacher")).toContain(course.teacherId);
    expect(students.size).toBeGreaterThanOrEqual(2);
  });

  it("has two modules whose items all exist, and places everything it makes", () => {
    const keys = {
      activity: new Set(course.activities.map((a) => a.key)),
      quiz: new Set(course.quizzes.map((q) => q.key)),
      discussion: new Set(course.discussions.map((d) => d.key)),
    };
    const placed = course.modules.flatMap((m) => m.items);
    for (const item of placed) expect(keys[item.kind].has(item.key), `${item.kind} ${item.key}`).toBe(true);
    expect(placed.map((i) => `${i.kind}:${i.key}`).toSorted()).toStrictEqual([
      ...[...keys.activity].map((k) => `activity:${k}`),
      ...[...keys.quiz].map((k) => `quiz:${k}`),
      ...[...keys.discussion].map((k) => `discussion:${k}`),
    ].toSorted());
    expect(course.activities.length).toBeGreaterThanOrEqual(2);
    expect(course.activities.length).toBeLessThanOrEqual(4);
    expect(course.announcements.length).toBeGreaterThan(0);
    expect(course.weeklyNote.trim()).not.toBe("");
  });

  it("scripts work only for the class's active students, scored on its rubric's own criteria and levels", () => {
    for (const activity of course.activities) {
      const max = rubricMaxPoints(activity.rubric);
      expect(max).toBeGreaterThan(0);
      for (const [student, work] of Object.entries(activity.work)) {
        expect(students.has(student as never), `${activity.key} ${student}`).toBe(true);
        if (work.stage !== "graded" && work.stage !== "released") continue;
        expect(Object.keys(work.scores).toSorted()).toStrictEqual(activity.rubric.criteria.map((c) => c.id).toSorted());
        for (const criterion of activity.rubric.criteria) {
          expect(criterion.levels.map((l) => l.points)).toContain(work.scores[criterion.id]);
        }
      }
      for (const key of activity.resources ?? []) expect(resources.some((r) => r.key === key), key).toBe(true);
      if (activity.template === "primary-source-analysis") expect(activity.resources?.length).toBeGreaterThan(0);
    }
  });

  it("answers every quiz item with an answer of its type", () => {
    for (const quiz of course.quizzes) {
      for (const [student, answers] of Object.entries(quiz.attempts)) {
        expect(students.has(student as never), `${quiz.key} ${student}`).toBe(true);
        expect(answers.map((a) => a.type)).toStrictEqual(quiz.items.map((i) => i.type));
      }
    }
  });

  it("has discussion posts only by its own students and teacher", () => {
    for (const discussion of course.discussions) {
      for (const [index, post] of discussion.posts.entries()) {
        expect(students.has(post.author as never) || post.author === course.teacherId, post.author).toBe(true);
        if (post.replyTo !== undefined) expect(post.replyTo).toBeLessThan(index);
      }
    }
  });
});

describe("the Northfield showcase", () => {
  it("covers each grade band with three classes, a quiz, and every stage of student work", () => {
    for (const band of SHOWCASE_BANDS) {
      const inBand = courses.filter((c) => c.band === band);
      expect(inBand, band).toHaveLength(3);
      expect(inBand.flatMap((c) => c.quizzes).length, band).toBeGreaterThan(0);
      const stages = new Set(inBand.flatMap((c) => c.activities.flatMap((a) => Object.values(a.work).map((w) => w.stage))));
      expect([...stages].toSorted(), band).toStrictEqual([...SHOWCASE_STAGES].toSorted());
      const students = new Set(inBand.flatMap((c) => enrolled(c.offeringId, "student")));
      expect(students.size, band).toBeGreaterThanOrEqual(3);
    }
  });

  it("has discussions in the 6-8 and 9-12 bands", () => {
    for (const band of ["6-8", "9-12"] as const) {
      expect(courses.filter((c) => c.band === band).flatMap((c) => c.discussions).length, band).toBeGreaterThan(0);
    }
  });

  it("gives each rubric its own ID, and each class only one entry", () => {
    const rubricIds = courses.flatMap((c) => c.activities.map((a) => a.rubric.rubricId));
    expect(new Set(rubricIds).size).toBe(rubricIds.length);
    expect(new Set(courses.map((c) => c.offeringId)).size).toBe(courses.length);
  });

  it("gives each guardian a child in two showcase classes' schools", () => {
    for (const relationship of NORTHFIELD_GUARDIANS) {
      const theirs = courses.filter((c) => enrolled(c.offeringId, "student").includes(relationship.studentPrincipalId));
      expect(theirs.length, relationship.id).toBeGreaterThan(0);
    }
  });
});
