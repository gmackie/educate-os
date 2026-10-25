import { describe, expect, it } from "vitest";
import { DistrictId, RosterProjection } from "@educateos/contracts";
import { createDirectoryPrincipalResolver } from "@educateos/identity";
import {
  CLASSROOM_ISSUER,
  ClassroomAdapter,
  ClassroomGradeSink,
  type ClassroomCourseWork,
  type ClassroomProvider,
  type ClassroomRosterEntry,
} from "../src/index.ts";
import { NORTHFIELD_LTI, rejection, withLtiPlatform } from "./helpers.ts";
import { AMARA, approval, BIO, createServicesWorld, ENG9, requestFor, RIVERA } from "./services-helpers.ts";

/** An in-memory Google Classroom. It makes no network calls. */
class FakeClassroom implements ClassroomProvider {
  readonly rosters = new Map<string, ClassroomRosterEntry[]>();
  readonly courseWork = new Map<string, ClassroomCourseWork[]>();
  readonly grades: { courseId: string; courseWorkId: string; userId: string; assignedGrade: number }[] = [];

  async listRoster(courseId: string) {
    return this.rosters.get(courseId) ?? [];
  }
  async listCourseWork(courseId: string) {
    return this.courseWork.get(courseId) ?? [];
  }
  async setAssignedGrade(input: { courseId: string; courseWorkId: string; userId: string; assignedGrade: number }) {
    this.grades.push(input);
  }
}

const COURSE = "classroom-course-bio-1";
const AMARA_GOOGLE = "google-user-100200300";
/** Northfield with Amara linked to her Google account. */
const NORTHFIELD_GOOGLE = withLtiPlatform(NORTHFIELD_LTI, CLASSROOM_ISSUER, { "prn_nf-student-amara": AMARA_GOOGLE });

async function setup() {
  const classroom = new FakeClassroom();
  classroom.rosters.set(COURSE, [
    { userId: "google-user-teacher-morgan", role: "teacher" },
    { userId: AMARA_GOOGLE, role: "teacher" },
  ]);
  classroom.courseWork.set(COURSE, [
    { id: "cw-cell-lab", title: "Cell lab report", maxPoints: 10 },
    { id: "cw-quiz", title: "Quiz", maxPoints: 5 },
  ]);
  const world = await createServicesWorld({
    directory: NORTHFIELD_GOOGLE,
    routes: () => [
      { offeringId: BIO, authority: "lms:nf-classroom", via: "google-classroom", courseId: COURSE },
      { offeringId: ENG9, authority: "local" },
    ],
    sinks: [new ClassroomGradeSink(classroom)],
  });
  const adapter = new ClassroomAdapter({
    districtId: DistrictId.parse("dst_northfield"),
    provider: classroom,
    routes: world.routes,
    now: world.clock.now,
  });
  return { world, classroom, adapter };
}

describe("Google Classroom adapter shell", () => {
  it("projects the course roster without trusting Classroom's roles", async () => {
    const { adapter } = await setup();
    const projection = await adapter.rosterProjection(BIO);
    expect(RosterProjection.parse(projection)).toEqual(projection);
    expect(projection.source).toEqual({ kind: "google-classroom", courseId: COURSE });
    const amara = projection.members.find((member) => member.identity.subject === AMARA_GOOGLE)!;
    // Classroom lists Amara as a teacher; that is metadata, and the directory still says student.
    expect(amara).toEqual({
      identity: { districtId: "dst_northfield", issuer: CLASSROOM_ISSUER, subject: AMARA_GOOGLE },
      status: "active",
      untrustedPlatformRoles: ["teacher"],
    });
    const resolved = await createDirectoryPrincipalResolver(NORTHFIELD_GOOGLE).resolve({ ...amara.identity, credential: "person" });
    expect(resolved.kind).toBe("student");
  });

  it("reads coursework only for an offering routed to Classroom", async () => {
    const { adapter } = await setup();
    expect((await adapter.courseWork(BIO)).map((work) => work.id)).toEqual(["cw-cell-lab", "cw-quiz"]);
    expect(await rejection(adapter.courseWork(ENG9))).toBe("conflict");
    expect(await rejection(adapter.rosterProjection(ENG9))).toBe("conflict");
  });

  it("publishes a teacher-approved grade through the same gate, once", async () => {
    const { world, classroom } = await setup();
    const approved = approval(world, "cw-cell-lab");
    world.approvals.record(approved);
    expect(await world.passback.publish(requestFor(approved))).toEqual({ status: "posted", route: "google-classroom" });
    expect(await world.passback.publish(requestFor(approved))).toEqual({ status: "already-posted", route: "google-classroom" });
    expect(classroom.grades).toEqual([{ courseId: COURSE, courseWorkId: "cw-cell-lab", userId: AMARA_GOOGLE, assignedGrade: 8 }]);
  });

  it("refuses an unapproved grade, a local offering, unknown coursework and a different maximum", async () => {
    const { world, classroom } = await setup();
    expect(await rejection(world.passback.publish(requestFor(approval(world, "cw-cell-lab"))))).toBe("policy-violation");

    const local = approval(world, "cw-essay", { offeringId: ENG9, approverId: RIVERA, studentId: AMARA });
    world.approvals.record(local);
    expect(await rejection(world.passback.publish(requestFor(local)))).toBe("conflict");

    const unknown = approval(world, "cw-not-in-course");
    world.approvals.record(unknown);
    expect(await rejection(world.passback.publish(requestFor(unknown)))).toBe("forbidden");

    // The quiz is out of 5; a grade approved out of 10 is not rescaled.
    const quiz = approval(world, "cw-quiz");
    world.approvals.record(quiz);
    expect(await rejection(world.passback.publish(requestFor(quiz)))).toBe("conflict");
    expect(classroom.grades).toEqual([]);
  });
});
