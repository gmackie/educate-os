import { describe, expect, it } from "vitest";
import { drawingPng, NORTHFIELD, NORTHFIELD_GUARDIANS, NORTHFIELD_SHOWCASE, recordingWav, SHOWCASE_BANDS, SHOWCASE_STAGES, rubricMaxPoints } from "../src/index.ts";
import { DRAWINGS } from "../src/showcase/drawings.ts";

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

describe("young learners' scripted drawings and recordings", () => {
  const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

  /** Inflates a zlib stream, checking its checksum, as a browser's PNG decoder would. */
  const inflate = async (data: Uint8Array) =>
    new Uint8Array(await new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());

  it.each(Object.entries(DRAWINGS))("draws %s as a valid 240 by 180 PNG", async (_, drawing) => {
    const png = drawingPng(drawing);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect([...png.subarray(0, 8)]).toStrictEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks: string[] = [];
    const idat: Uint8Array[] = [];
    for (let at = 8; at < png.length;) {
      const length = view.getUint32(at);
      const type = ascii(png, at + 4, at + 8);
      chunks.push(type);
      if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
      at += 12 + length;
    }
    expect(chunks).toStrictEqual(["IHDR", "PLTE", "IDAT", "IEND"]);
    expect([view.getUint32(16), view.getUint32(20)]).toStrictEqual([240, 180]);
    // Each row is a filter byte and 120 bytes of pixels, two to a byte.
    expect(idat).toHaveLength(1);
    const pixels = await inflate(idat[0]!);
    expect(pixels.length).toBe(180 * 121);
    // More than the paper: something was drawn.
    expect(new Set(pixels).size).toBeGreaterThan(2);
  });

  it("records a short WAV, different for each child", () => {
    const wav = recordingWav("prn_nf-student-noah:weather-chart:tell");
    expect([ascii(wav, 0, 4), ascii(wav, 8, 16), ascii(wav, 36, 40)]).toStrictEqual(["RIFF", "WAVEfmt ", "data"]);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint32(40, true) / view.getUint32(28, true)).toBeCloseTo(1.44, 1);
    expect(recordingWav("prn_nf-student-sofia:weather-chart:tell")).not.toStrictEqual(wav);
  });

  it("uses the young-learner templates in K-2, and gives every drawing step's handed-in work a drawing", () => {
    const k2 = courses.filter((c) => c.band === "K-2").flatMap((c) => c.activities);
    expect(k2.filter((a) => a.template === "picture-response").length).toBeGreaterThanOrEqual(2);
    expect(k2.filter((a) => a.template === "read-and-respond").length).toBeGreaterThanOrEqual(2);
    for (const activity of courses.flatMap((c) => c.activities)) {
      const draws = activity.template === "picture-response"
        || (activity.template === "read-and-respond" && activity.questions.some((q) => (q.answerBy ?? activity.answerBy) === "drawing"));
      if (!draws) continue;
      for (const [student, work] of Object.entries(activity.work)) {
        if (work.stage === "not-started" || work.stage === "draft" && activity.template === "read-and-respond") continue;
        expect(work.drawing, `${activity.key} ${student}`).toBeDefined();
      }
    }
  });

  it("answers every writing question of a read-and-respond activity", () => {
    for (const activity of courses.flatMap((c) => c.activities)) {
      if (activity.template !== "read-and-respond") continue;
      const writing = activity.questions.filter((q) => (q.answerBy ?? activity.answerBy) === "writing").length;
      for (const work of Object.values(activity.work)) {
        if (work.stage === "not-started" || writing === 0) continue;
        expect(work.answers?.length, activity.key).toBe(writing);
      }
    }
  });
});
