/**
 * Approval-backed Google Classroom changes: creating an assignment, and grading a submission.
 *
 * Creating is not idempotent, as Classroom takes no request ID, so it is claimed before it is sent
 * and a send whose outcome was lost is never retried. Grading sets `assignedGrade` and then returns
 * the submission, both of which are safe to repeat, so an interrupted grade is simply applied again.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, APPLY_OUTCOME_UNKNOWN_MESSAGE, defineActions,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { ClassroomNotOwnedError, type ClassroomApi } from "./classroom-api";
import type { ClassroomCourseWorkDraft } from "./classroom-types";
import { GoogleApiError } from "./google-response";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.google.classroom", vendorId: "google" });

/** What an approved change is written with. */
export type ClassroomHost = { api: ClassroomApi; courseId: string };

/** A grade awaiting approval, with what the approver is shown about it. */
export type ClassroomGrade = {
  courseWorkId: string;
  courseWorkTitle: string;
  maxPoints?: number;
  submissionId: string;
  userId: string;
  assignedGrade: number;
};

/** Each Classroom action's payload, by kind. */
export type ClassroomActions = {
  createCourseWork: { draft: ClassroomCourseWorkDraft };
  setGrade: ClassroomGrade;
};

/** A queued Classroom action. */
export type ClassroomAction = TaggedAction<ClassroomActions>;

// The statuses Google answers a request with when it refused it, so nothing was written.
const REFUSED_STATUSES = new Set([
  "INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE", "UNAUTHENTICATED",
  "PERMISSION_DENIED", "NOT_FOUND", "ALREADY_EXISTS",
]);

/** The provider error behind `error`, which `ClassroomApi` may have wrapped in a clearer one. */
function googleError(error: unknown): GoogleApiError | undefined {
  let cause = error instanceof Error && !(error instanceof GoogleApiError) ? error.cause : error;
  return cause instanceof GoogleApiError ? cause : undefined;
}

/**
 * Rethrows an apply failure classified for the kit: a refusal is terminal, since sending it again
 * would be refused again; a 429 or transient failure is left to be retried.
 */
function refusedOrRetryable(error: unknown): never {
  if (error instanceof ClassroomNotOwnedError) throw new ActionApplyError(error.message);
  let status = googleError(error)?.providerStatus;
  if (status !== undefined && REFUSED_STATUSES.has(status)) {
    throw new ActionApplyError((error as Error).message);
  }
  throw error;
}

/** The Classroom action set, bound once per course binding. */
export const CLASSROOM_ACTIONS = defineActions<ClassroomHost, ClassroomActions>({
  createCourseWork: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: ({ draft }, { courseId }) => ({
      title: sanitizeTitle(`Create Classroom assignment: ${draft.title}`),
      // The JSON is the assignment exactly as it will be created; none of its text is in the prose.
      ...buildDescription(
        `Create an assignment in Google Classroom course ${codeSpan(courseId)}. ` +
        (draft.state === "PUBLISHED"
          ? "It is **published**: the class sees it at once."
          : "It is created as a draft, which only the course's teachers see."))
        .inline("Course ID", courseId)
        .json("Assignment", draft)
        .finish(),
      implementsRevert: false,
    }),
    apply: async ({ draft }, { api, courseId }) => {
      try {
        await api.createCourseWork(courseId, draft);
      } catch (error) {
        // A refusal or a 429 created nothing; anything else may have.
        let status = googleError(error)?.providerStatus;
        if (status === undefined || !(REFUSED_STATUSES.has(status) || status === "RESOURCE_EXHAUSTED")) {
          throw new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
        }
        refusedOrRetryable(error);
      }
    },
  },

  setGrade: {
    delivery: "continue-with-simulation",
    describe: (grade, { courseId }) => {
      let outOf = grade.maxPoints === undefined ? "" : ` out of ${grade.maxPoints}`;
      return {
        title: sanitizeTitle(`Grade Classroom submission: ${grade.assignedGrade}${outOf}`),
        ...buildDescription(
          `Set the grade of a submission for ${codeSpan(grade.courseWorkTitle)} to ` +
          `**${grade.assignedGrade}**${outOf}, and return it to the student, who then sees the grade.`)
          .inline("Course ID", courseId)
          .inline("Coursework ID", grade.courseWorkId)
          .inline("Student user ID", grade.userId)
          .inline("Submission ID", grade.submissionId)
          .finish(),
        implementsRevert: false,
      };
    },
    apply: async (grade, { api, courseId }) => {
      try {
        await api.gradeAndReturn(courseId, grade.courseWorkId, grade.submissionId, grade.assignedGrade);
      } catch (error) {
        // The session refuses coursework this project did not create, so Google refusing it here
        // means the OAuth client's project has changed since the coursework was created.
        if (error instanceof ClassroomNotOwnedError) {
          logger.warn("Classroom refused a grade for coursework of another project", {
            event: "classroom.grade.project_permission_denied",
          });
        }
        refusedOrRetryable(error);
      }
    },
  },
}, { fence: "none", vendorId: "google" });
