// The Google Classroom provider behind `@educateos/lti`'s Classroom adapter and grade sink: rosters,
// the coursework EducateOS created, and teacher-approved grades written back. New for SCHO-77.
//
// Classroom lets a Cloud project change only the coursework it created, and Google refuses anything
// else with `@ProjectPermissionDenied`. So the provider creates the coursework it grades, lists only
// coursework Classroom reports as `associatedWithDeveloper`, and refuses locally what Google would
// refuse. Writes act as the course's owner, since only a course's teachers may create or grade its
// coursework; reads act as the district's administrator.
import { EducateOsError } from "@educateos/contracts";
import type { ErrorCode } from "@educateos/contracts";
import type { ClassroomCourseWork, ClassroomCourseWorkDraft, ClassroomProvider, ClassroomRosterEntry } from "@educateos/lti";
import { RosterSyncError } from "../sync-run.ts";
import { ClassroomRequestError } from "./client.ts";
import type { ClassroomCourseWorkRecord, GoogleClassroomClient, ListRead } from "./client.ts";

/**
 * A {@link ClassroomProvider} over the Classroom REST API, through domain-wide delegation. Its
 * client's tokens need `CLASSROOM_GRADE_SCOPES`.
 *
 * Failures are `EducateOsError`s: `forbidden` for coursework another project owns or a refused
 * scope, `not-found` for a course, coursework or submission Classroom does not have, and
 * `unavailable` when Classroom cannot be reached, is rate limiting, or has its API turned off.
 */
export class GoogleClassroomProvider implements ClassroomProvider {
  readonly #client: GoogleClassroomClient;
  readonly #owners = new Map<string, Promise<string>>();

  constructor(client: GoogleClassroomClient) {
    this.#client = client;
  }

  async listRoster(courseId: string): Promise<readonly ClassroomRosterEntry[]> {
    return guard(async () => {
      const teachers = strict(await this.#client.listTeachers(courseId), "roster");
      const students = strict(await this.#client.listStudents(courseId), "roster");
      return [
        ...teachers.map((m) => ({ userId: m.userId, role: "teacher" as const })),
        ...students.map((m) => ({ userId: m.userId, role: "student" as const })),
      ];
    });
  }

  async listCourseWork(courseId: string): Promise<readonly ClassroomCourseWork[]> {
    return this.#asOwner(courseId, async (owner) => (await this.#owned(courseId, owner)).map(columnOf));
  }

  /**
   * Creates the coursework, published. A create is sent once and never retried, since Google may
   * have acted on a request whose answer was lost. Instead, the description carries a reference
   * unique to this call, and when the answer is lost (a timeout, a 5xx, a dropped connection) the
   * course's coursework is searched for it, so the column is found rather than made twice.
   */
  async createCourseWork(input: { courseId: string; draft: ClassroomCourseWorkDraft }): Promise<ClassroomCourseWork> {
    const ref = `EducateOS column ${crypto.randomUUID()}`;
    const description = input.draft.description === undefined ? ref : `${input.draft.description}\n\n${ref}`;
    return this.#asOwner(input.courseId, async (owner) => {
      let created: ClassroomCourseWorkRecord;
      try {
        created = await this.#client.createCourseWork(input.courseId, {
          title: input.draft.title,
          description,
          maxPoints: input.draft.maxPoints,
          workType: "ASSIGNMENT",
          state: "PUBLISHED",
        }, owner);
      } catch (error) {
        if (!(error instanceof ClassroomRequestError) || (error.status !== undefined && error.status < 500)) throw error;
        const found = (await this.#owned(input.courseId, owner)).find((work) => work.description?.includes(ref) === true);
        if (found === undefined) throw error;
        created = found;
      }
      if (!created.associatedWithDeveloper) throw new EducateOsError("unavailable", "Classroom did not record the coursework as EducateOS's.");
      return columnOf(created);
    });
  }

  async setAssignedGrade(input: { courseId: string; courseWorkId: string; userId: string; assignedGrade: number }): Promise<void> {
    // Classroom keeps two decimal places; anything finer would publish a grade nobody approved.
    if (!Number.isFinite(input.assignedGrade) || input.assignedGrade < 0 || Math.round(input.assignedGrade * 100) / 100 !== input.assignedGrade) {
      throw new EducateOsError("validation-failed", "A Classroom grade is a non-negative number with at most two decimal places.");
    }
    return this.#asOwner(input.courseId, async (owner) => {
      const work = await this.#client.getCourseWork(input.courseId, input.courseWorkId, owner);
      if (!work.associatedWithDeveloper) {
        throw new EducateOsError("forbidden", "Classroom lets EducateOS grade only coursework it created.");
      }
      const submissions = strict(await this.#client.listSubmissions(input.courseId, input.courseWorkId, input.userId, owner), "submission list");
      const submission = submissions.find((s) => s.userId === input.userId);
      if (submission === undefined || submissions.length !== 1) {
        throw new EducateOsError("not-found", "The student has no submission for this coursework in Classroom.");
      }
      // Both grades are set, so the teacher's Classroom gradebook shows what they approved. The
      // submission is not returned: returning it to the student stays the teacher's action.
      await this.#client.patchSubmission(input.courseId, input.courseWorkId, submission.id, { assignedGrade: input.assignedGrade, draftGrade: input.assignedGrade }, owner);
    });
  }

  /** The course's published coursework that this project created. */
  async #owned(courseId: string, owner: string): Promise<ClassroomCourseWorkRecord[]> {
    return strict(await this.#client.listCourseWork(courseId, owner), "coursework list")
      .filter((work) => work.associatedWithDeveloper && work.state === "PUBLISHED");
  }

  /**
   * Runs a call acting as the course's owner. When Google refuses it, the cached owner is dropped,
   * so a course whose ownership moved is looked up afresh next time.
   */
  async #asOwner<T>(courseId: string, call: (owner: string) => Promise<T>): Promise<T> {
    return guard(async () => {
      try {
        return await call(await this.#owner(courseId));
      } catch (error) {
        if (error instanceof ClassroomRequestError && (error.code === "auth-failed" || error.status === 404)) this.#owners.delete(courseId);
        throw error;
      }
    });
  }

  /** The course owner's Workspace email, which writes act as. */
  #owner(courseId: string): Promise<string> {
    let owner = this.#owners.get(courseId);
    if (owner === undefined) {
      owner = (async () => {
        const course = await this.#client.getCourse(courseId);
        const teacher = await this.#client.getTeacher(courseId, course.ownerId);
        const email = teacher.profile?.emailAddress;
        if (email === undefined) {
          throw new EducateOsError("forbidden", "Classroom did not reveal the course owner's email; the classroom.profile.emails scope must be delegated.");
        }
        return email;
      })();
      owner.catch(() => this.#owners.delete(courseId));
      this.#owners.set(courseId, owner);
    }
    return owner;
  }
}

function columnOf(work: ClassroomCourseWorkRecord): ClassroomCourseWork {
  return { id: work.id, title: work.title, ...(work.maxPoints === undefined || work.maxPoints === 0 ? {} : { maxPoints: work.maxPoints }) };
}

/** A list in which every record must be readable. */
function strict<T>(read: ListRead<T>, what: string): T[] {
  if (read.invalid.length > 0) throw new EducateOsError("unavailable", `Classroom returned a malformed ${what}.`);
  return read.records;
}

/** Runs a call, turning Classroom's failures into `EducateOsError`s. */
async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof EducateOsError) throw error;
    if (error instanceof RosterSyncError) throw new EducateOsError(codeOf(error), messageOf(error));
    throw error;
  }
}

function codeOf(error: RosterSyncError): ErrorCode {
  const reasons = error instanceof ClassroomRequestError ? error.reasons : [];
  const status = error instanceof ClassroomRequestError ? error.status : undefined;
  if (reasons.includes("ClassroomApiDisabled")) return "unavailable";
  if (status === 404) return "not-found";
  if (status === 400) return "validation-failed";
  if (error.code === "auth-failed") return "forbidden";
  if (error.code === "internal-error") return "validation-failed";
  return "unavailable";
}

function messageOf(error: RosterSyncError): string {
  const reasons = error instanceof ClassroomRequestError ? error.reasons : [];
  if (reasons.includes("ProjectPermissionDenied")) return "Classroom lets EducateOS change only coursework it created.";
  if (reasons.includes("ClassroomApiDisabled")) {
    return "Classroom data access is turned off for this Google Workspace domain; an administrator must turn it on.";
  }
  if (reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return "The domain has not delegated a Classroom scope EducateOS needs.";
  return `Google Classroom: ${error.message}`;
}
