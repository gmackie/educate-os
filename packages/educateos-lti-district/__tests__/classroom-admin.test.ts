// The administrator's Google Classroom grade operations (SCHO-428): an offering's grades routed to
// the Classroom course its roster imported it from, and an assignment's [educateos-approved] column.
import { describe, expect, it } from "vitest";
import type { OfferingId } from "@educateos/contracts";
import type { ClassroomCourseWork, ClassroomCourseWorkDraft, ClassroomProvider } from "@educateos/lti";
import { ClassroomGradeAdminService } from "../src/index.ts";
import { ADMIN, AMARA, as, BIO, createDistrict, ENG9, gradedBiology, MORGAN, NF, rejection, SCHOOL_ADMIN } from "./setup.ts";

const COURSE = "896140534378";

/** Classroom holding only the coursework this project created, as the real provider lists it. */
class FakeClassroom implements ClassroomProvider {
  readonly work = new Map<string, ClassroomCourseWork[]>();
  readonly created: { courseId: string; draft: ClassroomCourseWorkDraft }[] = [];
  async listRoster() { return []; }
  async listCourseWork(courseId: string) { return this.work.get(courseId) ?? []; }
  async createCourseWork(input: { courseId: string; draft: ClassroomCourseWorkDraft }) {
    this.created.push(input);
    const work = { id: String(900 + this.created.length), title: input.draft.title, maxPoints: input.draft.maxPoints };
    this.work.set(input.courseId, [...this.work.get(input.courseId) ?? [], work]);
    return work;
  }
  async setAssignedGrade() {}
}

function classroomDistrict(courses: Partial<Record<OfferingId, string>> = { [BIO]: COURSE }) {
  const district = createDistrict();
  const classroom = new FakeClassroom();
  const service = new ClassroomGradeAdminService({
    districtId: NF,
    authorizer: district.engine,
    directory: district.loadDirectory,
    provider: classroom,
    courseOf: async (offeringId) => courses[offeringId],
    gradeRoutes: district.stores.gradeRoutes,
    gradeColumns: district.stores.gradeColumns,
    assessments: district.assessments,
  });
  return { district, classroom, service };
}

describe("ClassroomGradeAdminService (SCHO-428)", () => {
  it("routes an offering's grades to the Classroom course its roster imported it from", async () => {
    const { district, service } = classroomDistrict();
    const route = await service.routeGradesToClassroom(as(ADMIN), { offeringId: BIO });
    expect(route).toEqual({ offeringId: BIO, authority: "lms:google-classroom", via: "google-classroom", courseId: COURSE });
    expect(await district.stores.gradeRoutes.routeFor(BIO)).toEqual(route);
  });

  it("never takes the course from the caller, and refuses an offering not imported from Classroom", async () => {
    const { service } = classroomDistrict();
    expect(await rejection(service.routeGradesToClassroom(as(ADMIN), { offeringId: BIO, courseId: "1" }))).toBe("validation-failed");
    expect(await rejection(service.routeGradesToClassroom(as(ADMIN), { offeringId: ENG9 }))).toBe("not-found");
  });

  it("is an administrator's: teachers, students and unknown offerings are refused alike", async () => {
    const { service } = classroomDistrict();
    await service.routeGradesToClassroom(as(SCHOOL_ADMIN), { offeringId: BIO });
    expect(await rejection(service.routeGradesToClassroom(as(MORGAN), { offeringId: BIO }))).toBe("forbidden");
    expect(await rejection(service.routeGradesToClassroom(as(AMARA), { offeringId: BIO }))).toBe("forbidden");
    expect(await rejection(service.routeGradesToClassroom(as(ADMIN), { offeringId: "off_nf-ghost" }))).toBe("forbidden");
    expect(await rejection(service.classroomColumn(as(MORGAN), { offeringId: BIO, assignmentId: "asg_cell-lab", maxPoints: 10 }))).toBe("forbidden");
  });

  it("creates the assignment's approved column once, binds it, and finds it again on a rerun", async () => {
    const { district, classroom, service } = classroomDistrict();
    await district.assessments.commit(gradedBiology(), 0);
    // No route yet: Classroom is reached only through one.
    expect(await rejection(service.classroomColumn(as(ADMIN), { offeringId: BIO, assignmentId: "asg_cell-lab", maxPoints: 10 }))).toBe("conflict");
    await service.routeGradesToClassroom(as(ADMIN), { offeringId: BIO });

    const first = await service.classroomColumn(as(ADMIN), { offeringId: BIO, assignmentId: "asg_cell-lab", maxPoints: 10 });
    expect(first.created).toBe(true);
    expect(first.courseWork).toMatchObject({ title: "[educateos-approved] Cell lab", maxPoints: 10 });
    expect(classroom.created).toEqual([{ courseId: COURSE, draft: { title: "[educateos-approved] Cell lab", description: "Grades your teacher approved in EducateOS.", maxPoints: 10 } }]);
    expect(await district.stores.gradeColumns.assignmentFor(BIO, first.courseWork.id)).toBe("asg_cell-lab");

    const again = await service.classroomColumn(as(ADMIN), { offeringId: BIO, assignmentId: "asg_cell-lab", maxPoints: 10 });
    expect(again).toEqual({ courseWork: first.courseWork, created: false });
    expect(classroom.created).toHaveLength(1);
  });

  it("refuses an assignment of another offering, and never reuses a column bound to another assignment", async () => {
    const { district, classroom, service } = classroomDistrict();
    await district.assessments.commit(gradedBiology(), 0);
    await service.routeGradesToClassroom(as(ADMIN), { offeringId: BIO });
    expect(await rejection(service.classroomColumn(as(ADMIN), { offeringId: BIO, assignmentId: "asg_missing", maxPoints: 10 }))).toBe("not-found");

    // Coursework with the right title, but already carrying another assignment's grades.
    classroom.work.set(COURSE, [{ id: "777", title: "[educateos-approved] Cell lab", maxPoints: 10 }]);
    await district.stores.gradeColumns.bind({ offeringId: BIO, column: "777", assignmentId: "asg_other" as never });
    const made = await service.classroomColumn(as(ADMIN), { offeringId: BIO, assignmentId: "asg_cell-lab", maxPoints: 10 });
    expect(made.created).toBe(true);
    expect(made.courseWork.id).not.toBe("777");
  });
});
