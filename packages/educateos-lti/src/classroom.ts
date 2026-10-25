// Google Classroom adapter shell (roadmap I02). There is no real Google client here: integrating
// with Google Classroom is gated on verified API access and Google's partner terms, and nothing in
// this package calls Google. `ClassroomProvider` is the seam a real client will implement.
import { z } from "zod";
import { RosterProjection, EducateOsError, type DistrictId, type OfferingId, type Principal } from "@educateos/contracts";
import { routeOfKind, type ClassroomGradeRoute, type GradeDelivery, type GradeRouteStore, type GradeSink, type LmsGradeRoute } from "./passback.ts";
import type { Clock } from "./stores.ts";

/**
 * The issuer of the identities a Classroom roster names: Google's OpenID Connect issuer, whose
 * `sub` is the Google user ID Classroom reports. A district links its principals to these before a
 * Classroom roster can match anyone.
 */
export const CLASSROOM_ISSUER = "https://accounts.google.com";

const GoogleId = z.string().min(1).max(255);

/** One person on a Classroom course roster. `role` is which roster list Classroom put them on. */
export const ClassroomRosterEntry = z.strictObject({
  userId: GoogleId,
  role: z.enum(["teacher", "student"]),
});
/** A Classroom roster entry. */
export type ClassroomRosterEntry = z.infer<typeof ClassroomRosterEntry>;

/** One piece of Classroom coursework: a gradebook column. */
export const ClassroomCourseWork = z.strictObject({
  id: GoogleId,
  title: z.string().min(1).max(3000),
  /** Ungraded coursework has none. */
  maxPoints: z.number().positive().finite().optional(),
});
/** Classroom coursework. */
export type ClassroomCourseWork = z.infer<typeof ClassroomCourseWork>;

/**
 * The Google Classroom operations EducateOS uses, shaped after the Classroom API (`courses.students`
 * and `courses.teachers`, `courses.courseWork`, `studentSubmissions.patch` of `assignedGrade`).
 * Implementations validate what Google returns before handing it back.
 *
 * A real implementation is gated on verified Google API access and partner terms. Classroom only
 * lets a project grade coursework that project created, so a real client also creates the
 * coursework it grades.
 */
export interface ClassroomProvider {
  /** The course's teachers and students. */
  listRoster(courseId: string): Promise<readonly ClassroomRosterEntry[]>;
  /** The course's coursework. */
  listCourseWork(courseId: string): Promise<readonly ClassroomCourseWork[]>;
  /** Sets a student's assigned grade on one piece of coursework. */
  setAssignedGrade(input: { courseId: string; courseWorkId: string; userId: string; assignedGrade: number }): Promise<void>;
}

/** What {@link ClassroomAdapter} is built from. */
export interface ClassroomAdapterOptions {
  readonly districtId: DistrictId;
  readonly provider: ClassroomProvider;
  /** The grade routes: an offering is reached in Classroom only through a Classroom route. */
  readonly routes: GradeRouteStore;
  readonly now?: Clock;
}

/**
 * Reads an offering's Classroom course: its roster as a {@link RosterProjection} and its coursework.
 * An offering is tied to a Classroom course only by its grade route; an offering routed anywhere
 * else is refused, so EducateOS never reads one source's roster into another's offering. Grades go
 * through {@link ClassroomGradeSink}, which only the grade passback gate drives.
 */
export class ClassroomAdapter {
  readonly #options: ClassroomAdapterOptions;
  readonly #now: Clock;

  constructor(options: ClassroomAdapterOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** The course roster, projected for a sync adapter. Roles are carried as untrusted metadata. */
  async rosterProjection(offeringId: OfferingId): Promise<RosterProjection> {
    const route = await this.#route(offeringId);
    const entries = z.array(ClassroomRosterEntry).parse(await this.#options.provider.listRoster(route.courseId));
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.userId)) throw new EducateOsError("validation-failed", "The Classroom roster lists a person twice.");
      seen.add(entry.userId);
    }
    return RosterProjection.parse({
      districtId: this.#options.districtId,
      offeringId,
      source: { kind: "google-classroom", courseId: route.courseId },
      observedAt: new Date(this.#now()).toISOString(),
      members: entries.map((entry) => ({
        identity: { districtId: this.#options.districtId, issuer: CLASSROOM_ISSUER, subject: entry.userId },
        status: "active",
        untrustedPlatformRoles: [entry.role],
      })),
    });
  }

  /** The course's coursework. */
  async courseWork(offeringId: OfferingId): Promise<ClassroomCourseWork[]> {
    const route = await this.#route(offeringId);
    return z.array(ClassroomCourseWork).parse(await this.#options.provider.listCourseWork(route.courseId));
  }

  async #route(offeringId: OfferingId): Promise<ClassroomGradeRoute> {
    const route = await this.#options.routes.routeFor(offeringId);
    if (route === undefined || route.authority === "local" || route.via !== "google-classroom") {
      throw new EducateOsError("conflict", "This offering is not connected to Google Classroom.");
    }
    return route;
  }
}

/** Publishes approved grades to Classroom coursework. A {@link GradeSink} for the passback gate. */
export class ClassroomGradeSink implements GradeSink {
  readonly via = "google-classroom";
  readonly #provider: ClassroomProvider;

  constructor(provider: ClassroomProvider) {
    this.#provider = provider;
  }

  async check(route: LmsGradeRoute, column: string, student: Principal): Promise<void> {
    await this.#target(routeOfKind(route, "google-classroom"), column, student);
  }

  async deliver(input: LmsGradeRoute, delivery: GradeDelivery, student: Principal): Promise<void> {
    const route = routeOfKind(input, "google-classroom");
    const { courseWork, userId } = await this.#target(route, delivery.column, student);
    // Classroom grades are points against the coursework's own maximum. Rescaling would publish a
    // number the teacher never approved, so a differing maximum is refused instead.
    if (courseWork.maxPoints !== delivery.scoreMaximum) {
      throw new EducateOsError("conflict", "The Classroom coursework is out of a different number of points than the approved grade.");
    }
    await this.#provider.setAssignedGrade({ courseId: route.courseId, courseWorkId: courseWork.id, userId, assignedGrade: delivery.scoreGiven });
  }

  async #target(route: ClassroomGradeRoute, column: string, student: Principal) {
    const courseWork = z
      .array(ClassroomCourseWork)
      .parse(await this.#provider.listCourseWork(route.courseId))
      .find((candidate) => candidate.id === column);
    if (courseWork === undefined) throw new EducateOsError("forbidden", "The coursework is not in this course's gradebook.");
    const identity = student.externalIdentities.find((link) => link.issuer === CLASSROOM_ISSUER);
    if (identity === undefined) throw new EducateOsError("not-found", "The student has no Google account linked.");
    return { courseWork, userId: identity.subject };
  }
}
