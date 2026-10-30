import { beforeAll, describe, expect, it } from "vitest";
import { bootCedarValley, type CedarValleyDistrict } from "../districts/cedarvalley.ts";
import { CEDARVALLEY_PERSONAS } from "../districts/cedarvalleyPersonas.ts";
import type { GradeRouteKind } from "./types.ts";

const subjectOf = (id: string) => CEDARVALLEY_PERSONAS.find((p) => p.id === id)!.subject;

/** A synced Cedar Valley, its teacher, and An Nguyen's submission in Earth Science 8 waiting for a grade. */
async function graded() {
  const district = await bootCedarValley();
  await district.roster.sync();
  // In a session, as Cedar Valley's Clever sign-in starts one: the district takes no bare subject.
  const teacher = district.clientFor(district.sessions.start({ issuer: district.cleverSso.issuer, subject: subjectOf("teacher"), credential: "person" }));
  const offerings = await teacher.call("teacher.listOfferings");
  const earthScience = offerings.find(({ course }) => course.title === "Earth Science 8")!.offering.id;
  const [assignment] = await teacher.call("teacher.listAssignments", { params: { offeringId: earthScience } });
  const [submission] = await teacher.call("teacher.listSubmissions", { params: { assignmentId: assignment!.id } });
  const grade = (points: number) => teacher.call("teacher.recordGrade", { params: { submissionId: submission!.id }, body: { score: { points, maxPoints: 5 } } });
  return { district, teacher, earthScience, grade };
}

/** The grade writes each gradebook has received: Classroom PATCHes a submission, LMS Connect PATCHes one. */
const writes = (district: CedarValleyDistrict) => ({
  "google-classroom": district.grades.classroom.requests.filter((r) => r.method === "PATCH").length,
  "clever-lms-connect": district.clever.requests.filter((r) => r.method === "PATCH").length,
});

const ROUTES: readonly GradeRouteKind[] = ["google-classroom", "clever-lms-connect"];

describe("grade passback in Cedar Valley", () => {
  let world: Awaited<ReturnType<typeof graded>>;
  beforeAll(async () => {
    world = await graded();
  });

  it("gives every class a route, Google Classroom until the teacher chooses otherwise", async () => {
    const classes = await world.district.grades.classes();
    expect(classes.map(({ title, route }) => [title, route])).toEqual([
      ["Algebra I", "google-classroom"],
      ["Earth Science 8", "google-classroom"],
      ["English 8", "google-classroom"],
      ["World History 7", "google-classroom"],
    ]);
  });
});

describe.each(ROUTES)("an approved grade through %s", (route) => {
  let district: CedarValleyDistrict;
  let earthScience: string;
  beforeAll(async () => {
    ({ district, earthScience } = await graded().then(async (w) => {
      w.district.grades.setRoute(w.earthScience, route);
      await w.grade(4);
      return w;
    }));
  });

  it("lands once in the chosen gradebook, and nowhere else", async () => {
    const [event] = district.grades.events();
    expect(event).toMatchObject({ outcome: "posted", via: route, studentName: "An Nguyen", className: "Earth Science 8", assignmentTitle: "Where does the rain go?", scoreGiven: 4, scoreMaximum: 5, gradeVersion: 1 });
    if (event?.outcome !== "posted") throw new Error("not posted");
    const { landed } = event;
    if (landed.via === "google-classroom") {
      expect(landed).toMatchObject({ courseWorkTitle: "Where does the rain go?", assignedGrade: 4, maxPoints: 5 });
    } else {
      expect(landed).toMatchObject({ sectionName: "Earth Science 8 - Whitaker", assignmentTitle: "Where does the rain go?", gradePoints: 4, pointsPossible: 5 });
      // Read back from the fake, not from what was sent.
      expect(district.clever.submissionFor(landed.sectionId, landed.assignmentId, district.clever.userId("prn_cv-student-an"))?.grade_points).toBe(4);
    }
    const other = ROUTES.find((r) => r !== route)!;
    expect(writes(district)).toEqual({ [route]: 1, [other]: 0 });
  });

  it("does not post again when the same version is retried", async () => {
    const [first] = district.grades.events();
    const retry = await district.grades.resend(first!.id);
    expect(retry).toMatchObject({ outcome: "already-posted", via: route, gradeVersion: 1 });
    // A request that approves nothing finds no new grade to send.
    await district.roster.sync();
    expect(district.grades.events()).toHaveLength(2);
    expect(writes(district)[route]).toBe(1);
  });

  it("refuses a grade no teacher approved, with the gate's reason, writing nothing", async () => {
    const before = writes(district);
    const refused = await district.grades.tryUnapproved(earthScience);
    expect(refused).toMatchObject({ outcome: "refused", via: route, code: "policy-violation", reason: "This grade has not been approved by the offering's teacher." });
    expect(writes(district)).toEqual(before);
  });
});

describe("switching a class's route", () => {
  it("sends its next approved grade to the other gradebook, and leaves the last one where it landed", async () => {
    const { district, earthScience, grade } = await graded();
    await grade(3);
    district.grades.setRoute(earthScience, "clever-lms-connect");
    expect((await district.grades.classes()).find((c) => c.offeringId === earthScience)?.route).toBe("clever-lms-connect");
    await grade(5);

    const [first, second] = district.grades.events();
    expect(first).toMatchObject({ outcome: "posted", via: "google-classroom", gradeVersion: 1, landed: { assignedGrade: 3 } });
    expect(second).toMatchObject({ outcome: "posted", via: "clever-lms-connect", gradeVersion: 2, landed: { gradePoints: 5 } });
    expect(writes(district)).toEqual({ "google-classroom": 1, "clever-lms-connect": 1 });

    // Classroom still holds version 1: the change went only where the class now sends its grades.
    const { courseId, courseWorkId } = first!.outcome === "posted" && first!.landed.via === "google-classroom" ? first!.landed : { courseId: "", courseWorkId: "" };
    const classroom = district.grades.classroom;
    expect(classroom.courseWorkOf(courseId).map((w) => w["id"])).toContain(courseWorkId);
    expect(classroom.submission(classroom.submissionId(courseWorkId, "prn_cv-student-an"))?.["assignedGrade"]).toBe(3);
  });

  it("tells its subscribers about every attempt and every route change", async () => {
    const { district, earthScience, grade } = await graded();
    const heard: (string | undefined)[] = [];
    const stop = district.grades.subscribe((event) => heard.push(event?.outcome));
    district.grades.setRoute(earthScience, "clever-lms-connect");
    await grade(2);
    stop();
    await grade(3);
    expect(heard).toEqual([undefined, "posted"]);
  });
});
