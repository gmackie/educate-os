// The district administrator's Google Classroom grade operations (SCHO-428): the Classroom
// counterpart of routing an offering's grades to an LTI platform and creating its AGS line item.
// A route names the offering's own Classroom course, which the district's Classroom roster
// recorded when it imported the offering: an administrator chooses the offering, never the course.
import { z } from "zod";
import { OfferingId, EducateOsError, type Authorizer, type Caller, type DistrictDirectorySnapshot, type DistrictId } from "@educateos/contracts";
import { AssignmentId, type AssessmentRecordStore } from "@educateos/assessment";
import { ClassroomAdapter, type ClassroomCourseWork, type ClassroomGradeRoute, type ClassroomProvider } from "@educateos/lti";
import type { ConfigurableGradeRouteStore } from "./stores.ts";
import type { GradeColumnStore } from "./columns.ts";
import { authorizeLtiOffering } from "./authorize.ts";

/** The grade authority a Classroom route records. */
export const CLASSROOM_GRADE_AUTHORITY = "lms:google-classroom";

/** The prefix of the coursework that carries an assignment's approved grades in Classroom. */
export const APPROVED_COURSEWORK_PREFIX = "[educateos-approved]";

/** Which offering's grades should go to its Classroom course. */
export const ClassroomGradeRouteInput = z.strictObject({ offeringId: OfferingId });

/** Which assignment's approved grades a Classroom column should carry, out of how many points. */
export const ClassroomCourseWorkInput = z.strictObject({
  offeringId: OfferingId,
  assignmentId: AssignmentId,
  /** The points the teacher's approvals are out of; the sink refuses any other maximum. */
  maxPoints: z.number().positive().finite().max(100_000),
});

/** What {@link ClassroomGradeAdminService} is built from. */
export interface ClassroomGradeAdminOptions {
  readonly districtId: DistrictId;
  readonly authorizer: Authorizer;
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  /** Writes to Classroom as each course's owner. */
  readonly provider: ClassroomProvider;
  /**
   * The Classroom course an offering was imported from, when the head configuration's roster is
   * Google Classroom; otherwise `undefined`.
   */
  readonly courseOf: (offeringId: OfferingId) => Promise<string | undefined>;
  readonly gradeRoutes: ConfigurableGradeRouteStore;
  readonly gradeColumns: GradeColumnStore;
  readonly assessments: AssessmentRecordStore;
}

/** The coursework a Classroom column call found or made, and whether it made it. */
export interface ClassroomColumn { courseWork: ClassroomCourseWork; created: boolean }

/**
 * Routes an offering's official grades to its Google Classroom course, and gives an assignment a
 * Classroom column. Grades themselves still go only through the passback gate, published by the
 * teacher who approved them. Every call needs `update` on the offering.
 */
export class ClassroomGradeAdminService {
  readonly #options: ClassroomGradeAdminOptions;
  readonly #adapter: ClassroomAdapter;

  constructor(options: ClassroomGradeAdminOptions) {
    this.#options = options;
    this.#adapter = new ClassroomAdapter({ districtId: options.districtId, provider: options.provider, routes: options.gradeRoutes });
  }

  /** Makes the offering's own Classroom course its source of record for official grades. */
  async routeGradesToClassroom(caller: Caller, rawInput: unknown): Promise<ClassroomGradeRoute> {
    const input = ClassroomGradeRouteInput.safeParse(rawInput);
    if (!input.success) throw new EducateOsError("validation-failed", "The grade route is malformed.");
    const offeringId = await this.#authorize(caller, input.data.offeringId);
    const courseId = await this.#options.courseOf(offeringId);
    if (courseId === undefined) throw new EducateOsError("not-found", "This offering was not imported from Google Classroom.");
    const route: ClassroomGradeRoute = { offeringId, authority: CLASSROOM_GRADE_AUTHORITY, via: "google-classroom", courseId };
    await this.#options.gradeRoutes.setRoute(route);
    return route;
  }

  /**
   * Finds or creates the assignment's `[educateos-approved]` coursework in the offering's Classroom
   * course, and binds it as the column the assignment's approved grades publish to. Coursework is
   * found again by its title, maximum and binding, so a rerun creates nothing; coursework bound to
   * another assignment is never reused.
   */
  async classroomColumn(caller: Caller, rawInput: unknown): Promise<ClassroomColumn> {
    const input = ClassroomCourseWorkInput.safeParse(rawInput);
    if (!input.success) throw new EducateOsError("validation-failed", "The Classroom column is malformed.");
    const { assignmentId, maxPoints } = input.data;
    const offeringId = await this.#authorize(caller, input.data.offeringId);
    const { state } = await this.#options.assessments.load();
    const assignment = state.assignments.find((a) => a.id === assignmentId);
    if (assignment === undefined || assignment.offeringId !== offeringId || assignment.districtId !== this.#options.districtId) {
      throw new EducateOsError("not-found", "No such assignment in that offering.");
    }
    const title = `${APPROVED_COURSEWORK_PREFIX} ${assignment.title}`;
    let existing: ClassroomCourseWork | undefined;
    for (const work of await this.#adapter.courseWork(offeringId)) {
      if (work.title !== title || work.maxPoints !== maxPoints) continue;
      const bound = await this.#options.gradeColumns.assignmentFor(offeringId, work.id);
      if (bound === undefined || bound === assignmentId) { existing = work; break; }
    }
    const courseWork = existing ?? await this.#adapter.createCourseWork(offeringId, {
      title,
      description: "Grades your teacher approved in EducateOS.",
      maxPoints,
    });
    await this.#options.gradeColumns.bind({ offeringId, column: courseWork.id, assignmentId });
    return { courseWork, created: existing === undefined };
  }

  async #authorize(caller: Caller, rawOfferingId: unknown): Promise<OfferingId> {
    const { authorizer, districtId } = this.#options;
    return authorizeLtiOffering({ authorizer, districtId, directory: await this.#options.directory() }, caller, "update", rawOfferingId, forbidden);
  }
}

const forbidden = (): EducateOsError => new EducateOsError("forbidden", "You cannot manage this course connection.");
