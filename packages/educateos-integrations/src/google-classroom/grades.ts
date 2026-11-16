// Reading a course's Classroom grades, live and read-only, for EducateOS's "From Google Classroom"
// panel (SCHO-403). Classroom stays the record: nothing read is stored and nothing is written.
//
// Coursework and submissions are read acting as the course's owner, as `provider.ts` reads them,
// since Classroom shows coursework to the course's teachers. Reading coursework another Cloud
// project created is allowed; only changing it is refused.
import { RosterSyncError } from "../sync-run.ts";
import type { ClassroomCourseWorkRecord, ClassroomSubmissionRecord, GoogleClassroomClient } from "./client.ts";

/** How much one grade read may take on. */
export interface ClassroomGradeReadLimits {
  /** The most coursework read, most recently updated first. */
  maxCourseWork: number;
  /** The most submissions read for a whole class. */
  maxSubmissions: number;
  /** How long one read may take in all, whatever its requests' own timeouts. */
  deadlineMs: number;
}

/** Limits for a page load: the 50 most recent pieces of coursework, answered within 15 seconds. */
export const DEFAULT_CLASSROOM_GRADE_READ_LIMITS: ClassroomGradeReadLimits = {
  maxCourseWork: 50,
  maxSubmissions: 3000,
  deadlineMs: 15_000,
};

/** What one grade read found in a course. */
export interface ClassroomGradeRead {
  /** The course's page in Classroom. */
  courseLink?: string;
  /** Its published coursework, most recently updated first, at most `maxCourseWork`. */
  courseWork: ClassroomCourseWorkRecord[];
  /** Submissions to that coursework (others are dropped), each naming its `courseWorkId`. */
  submissions: ClassroomSubmissionRecord[];
  /** Whether a cap left coursework or submissions unread. */
  truncated: boolean;
}

/**
 * Reads Classroom grades through a client whose tokens hold `CLASSROOM_GRADE_READ_SCOPES` (or
 * their read-write form). A student's read lists only their own returned submissions, filtered by
 * Classroom itself, so no other student's submission is ever fetched for them.
 *
 * Failures reject: the client's `RosterSyncError`s, a malformed list, or the deadline passing. The
 * caller treats any of them as Classroom being unavailable.
 */
export class ClassroomGradeReader {
  readonly #client: GoogleClassroomClient;
  readonly #limits: ClassroomGradeReadLimits;
  readonly #owners = new Map<string, Promise<{ email: string; link: string | undefined }>>();

  constructor(client: GoogleClassroomClient, limits: ClassroomGradeReadLimits = DEFAULT_CLASSROOM_GRADE_READ_LIMITS) {
    this.#client = client;
    this.#limits = limits;
  }

  /** One student's returned submissions in a course, by their Classroom user ID. */
  student(courseId: string, userId: string): Promise<ClassroomGradeRead> {
    return this.#read(courseId, { userId, states: ["RETURNED"] });
  }

  /** Every student's submissions in a course. */
  course(courseId: string): Promise<ClassroomGradeRead> {
    return this.#read(courseId, {});
  }

  #read(courseId: string, filter: { userId?: string; states?: readonly string[] }): Promise<ClassroomGradeRead> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RosterSyncError("source-unavailable", "the Classroom grade read took too long")), this.#limits.deadlineMs);
    });
    return Promise.race([this.#readAll(courseId, filter), deadline]).finally(() => clearTimeout(timer));
  }

  async #readAll(courseId: string, filter: { userId?: string; states?: readonly string[] }): Promise<ClassroomGradeRead> {
    const owner = await this.#owner(courseId);
    try {
      const [work, submitted] = await Promise.all([
        this.#client.listCourseWork(courseId, owner.email, this.#limits.maxCourseWork),
        this.#client.listCourseSubmissions(courseId, owner.email, {
          ...filter,
          // A student's own returned work is small, but is capped the same way.
          maxItems: this.#limits.maxSubmissions,
        }),
      ]);
      if (work.invalid.length > 0 || submitted.invalid.length > 0) {
        throw new RosterSyncError("invalid-response", "Classroom returned a malformed coursework or submission list");
      }
      const courseWork = work.records.filter((w) => w.state === "PUBLISHED").slice(0, this.#limits.maxCourseWork);
      const kept = new Set(courseWork.map((w) => w.id));
      const submissions = submitted.records
        .filter((s) => s.courseWorkId !== undefined && kept.has(s.courseWorkId))
        .filter((s) => filter.userId === undefined || s.userId === filter.userId)
        .slice(0, this.#limits.maxSubmissions);
      return {
        ...(owner.link === undefined ? {} : { courseLink: owner.link }),
        courseWork,
        submissions,
        truncated: work.truncated === true || submitted.truncated === true,
      };
    } catch (error) {
      // A refusal may mean the course changed hands; look its owner up afresh next time.
      this.#owners.delete(courseId);
      throw error;
    }
  }

  /** The course owner's Workspace email, which reads act as, and the course's link. */
  #owner(courseId: string): Promise<{ email: string; link: string | undefined }> {
    let owner = this.#owners.get(courseId);
    if (owner === undefined) {
      owner = (async () => {
        const course = await this.#client.getCourse(courseId);
        const teacher = await this.#client.getTeacher(courseId, course.ownerId);
        const email = teacher.profile?.emailAddress;
        if (email === undefined) throw new RosterSyncError("auth-failed", "Classroom did not reveal the course owner's email");
        return { email, link: course.alternateLink };
      })();
      owner.catch(() => this.#owners.delete(courseId));
      this.#owners.set(courseId, owner);
    }
    return owner;
  }
}
