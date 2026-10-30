// The changes a Clever connection can make, each submitted for approval and made only once a person
// approves it: creating an assignment and setting a grade (teachers and district administrators),
// and turning in work (students). All three are shown to later reads as if already made.
//
// Every apply re-checks that the connection still reaches the section in its role, so an approval
// that outlives the user's place on a roster (or their administrator role) is refused, not sent.
//
// Creating is not idempotent: LMS Connect takes no request ID. It is claimed before it is sent, and
// a send whose outcome was lost is never retried. Grading and turning in set fields to fixed
// values, so an interrupted one is simply applied again.

import {
  ActionApplyError, ActionOutcomeUnknownError, APPLY_OUTCOME_UNKNOWN_MESSAGE, defineActions,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { createLogger } from "@gadgets/observability/logger";
import type { CleverAccess, SectionRole } from "./clever-access";
import { CleverOutcomeUnknownError, CleverRefusedError } from "./clever-api";
import { VENDOR_ID } from "./clever-env";
import { CleverError } from "./clever-errors";
import type { CleverDistrictLedger } from "./clever-ledger";

const logger = createLogger<{ vendorId: string; action: number }>({
  component: "gatekeeper.clever.actions", vendorId: VENDOR_ID,
});

/** What approved changes are made with. */
export type CleverActionHost = {
  /** The roster a section must list the connection's user on. */
  role: SectionRole;
  access: CleverAccess;
  ledger(districtId: string): DurableObjectStub<CleverDistrictLedger>;
  /** Records a change in the district's audit log; present only on the district-wide connection. */
  audit?(userId: string, districtId: string, action: string, target: string): Promise<void>;
};

/** An assignment to create, as the session validated it. */
export type AssignmentDraftPayload = {
  title: string;
  description?: string;
  pointsPossible: number;
  /** ISO 8601. */
  dueDate?: string;
};

/** Each action's payload, by kind. */
export type CleverActions = {
  createAssignment: { sectionId: string; sectionName: string; draft: AssignmentDraftPayload };
  setGrade: {
    sectionId: string;
    sectionName: string;
    assignmentId: string;
    assignmentTitle: string;
    pointsPossible: number;
    studentId: string;
    studentName: string;
    points: number;
    comment?: string;
  };
  turnIn: { sectionId: string; sectionName: string; assignmentId: string; assignmentTitle: string };
};

/** A queued Clever action. */
export type CleverAction = TaggedAction<CleverActions>;

/** The roster each action is made from. */
const ROLES: Record<keyof CleverActions, readonly SectionRole[]> = {
  createAssignment: ["teacher", "district"],
  setGrade: ["teacher", "district"],
  turnIn: ["student"],
};

/** Re-checks, at apply time, that the connection still reaches the section in its role. */
async function reach(host: CleverActionHost, kind: keyof CleverActions, sectionId: string) {
  if (!ROLES[kind].includes(host.role)) {
    throw new ActionApplyError("This connection cannot make this change.");
  }
  try {
    return await host.access.section(host.role, sectionId);
  } catch (error) {
    // A refusal is terminal: the user no longer reaches the section, so nothing was sent.
    if (error instanceof CleverError && (error.code === "not-found" || error.code === "forbidden")) {
      throw new ActionApplyError(error.message);
    }
    throw error;
  }
}

/** Classifies a failed write for the kit: refused is terminal; anything else may be retried. */
function writeFailed(error: unknown, idempotent: boolean): never {
  if (error instanceof CleverRefusedError) throw new ActionApplyError(error.message);
  if (error instanceof CleverOutcomeUnknownError && !idempotent) {
    throw new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
  }
  throw error;
}

async function audit(host: CleverActionHost, identity: { userId: string; districtId: string }, action: string, target: string) {
  await host.audit?.(identity.userId, identity.districtId, action, target);
}

/** The Clever action set, bound once per binding. */
export const CLEVER_ACTIONS = defineActions<CleverActionHost, CleverActions>({
  createAssignment: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: ({ sectionId, sectionName, draft }) => ({
      title: sanitizeTitle(`Create Clever assignment: ${draft.title}`),
      // The JSON is the assignment exactly as it will be created; none of its text is in the prose.
      ...buildDescription(
        `Create an assignment for every student of the Clever section ${codeSpan(sectionName)}, in the ` +
        "section's learning management system. Students see it once it is created.")
        .inline("Section ID", sectionId)
        .json("Assignment", draft)
        .finish(),
      implementsRevert: false,
    }),
    apply: async ({ sectionId, draft }, host, ctx) => {
      const { context } = await reach(host, "createAssignment", sectionId);
      let created;
      try {
        created = await context.api.createAssignment(sectionId, draft);
      } catch (error) {
        writeFailed(error, false);
      }
      try {
        await host.ledger(context.identity.districtId).recordAssignment({
          sectionId,
          assignmentId: created.id,
          title: draft.title,
          ...(draft.description === undefined ? {} : { description: draft.description }),
          pointsPossible: draft.pointsPossible,
          ...(draft.dueDate === undefined ? {} : { dueDate: draft.dueDate }),
          createdAt: Date.now(),
          createdBy: context.identity.userId,
        });
      } catch (error) {
        // Created but not registered: it exists in the LMS, and is invisible here.
        logger.error("created a Clever assignment but could not register it", {
          event: "clever.assignment.register_failed", action: ctx.id, error,
        });
        throw new ActionOutcomeUnknownError(
          "The assignment was created in the learning management system, but could not be recorded " +
          "here, so it will not be listed. Check the section's gradebook before creating it again.");
      }
      await audit(host, context.identity, "applied:create-assignment", `section:${sectionId}/assignment:${created.id}`);
    },
  },

  setGrade: {
    delivery: "continue-with-simulation",
    describe: grade => ({
      title: sanitizeTitle(`Grade Clever assignment: ${grade.points} out of ${grade.pointsPossible}`),
      ...(() => {
        let builder = buildDescription(
          `Record **${grade.points}** out of ${grade.pointsPossible} for ${codeSpan(grade.studentName)} on ` +
          `${codeSpan(grade.assignmentTitle)}, in the gradebook of the Clever section ` +
          `${codeSpan(grade.sectionName)}.`)
          .inline("Section ID", grade.sectionId)
          .inline("Assignment ID", grade.assignmentId)
          .inline("Student user ID", grade.studentId);
        if (grade.comment !== undefined) builder = builder.verbatim("Comment", grade.comment);
        return builder.finish();
      })(),
      implementsRevert: false,
    }),
    apply: async (grade, host) => {
      const { context, section } = await reach(host, "setGrade", grade.sectionId);
      if (!section.students.includes(grade.studentId)) {
        throw new ActionApplyError("The student is no longer on the section's roster.");
      }
      try {
        await context.api.updateSubmission(grade.sectionId, grade.assignmentId, grade.studentId, {
          gradePoints: grade.points,
          ...(grade.comment === undefined ? {} : { gradeComment: grade.comment }),
        });
      } catch (error) {
        writeFailed(error, true);
      }
      await audit(host, context.identity, "applied:set-grade",
        `section:${grade.sectionId}/assignment:${grade.assignmentId}/student:${grade.studentId}`);
    },
  },

  turnIn: {
    delivery: "continue-with-simulation",
    describe: ({ sectionId, sectionName, assignmentId, assignmentTitle }) => ({
      title: sanitizeTitle(`Turn in Clever assignment: ${assignmentTitle}`),
      ...buildDescription(
        `Turn in your own work for ${codeSpan(assignmentTitle)} in the Clever section ${codeSpan(sectionName)}. ` +
        "Your teacher sees it as submitted.")
        .inline("Section ID", sectionId)
        .inline("Assignment ID", assignmentId)
        .finish(),
      implementsRevert: false,
    }),
    apply: async ({ sectionId, assignmentId }, host) => {
      const { context } = await reach(host, "turnIn", sectionId);
      try {
        await context.api.updateSubmission(sectionId, assignmentId, context.identity.userId, { state: "submitted" });
      } catch (error) {
        writeFailed(error, true);
      }
    },
  },
}, { fence: "none", vendorId: VENDOR_ID });
