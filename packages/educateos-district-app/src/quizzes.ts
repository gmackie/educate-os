// Quizzes (SCHO-191): the assessment records a quiz's attempts and scores become. Q → W01 → W02 →
// E01: a submitted attempt's answer sheet is saved as an `evidence` artifact in the student's course
// workspace (W01 opens it on first use, W02 saves it) and submitted to the quiz's assignment (E01),
// so the attempt has an immutable, digest-pinned submission and a receipt like any other work. A
// release records the scores through E01's official-grade gate, as one action. The quiz service
// decides nothing here that these services do not decide again.
import type { ArtifactType, Caller, VerifiedPrincipal } from "@educateos/contracts";
import type { AssessmentRecordStore, AssessmentService, AssignmentBinding } from "@educateos/assessment";
import type { LearningArtifacts } from "@educateos/learning-artifacts";
import type { QuizAssignment, QuizGrading } from "@educateos/quizzes";
import type { WorkspaceDirectory } from "@educateos/workspaces";

/** The artifact type a quiz attempt's answer sheet is saved as. */
const ANSWER_SHEET_TYPE: ArtifactType = "evidence";

/** When an assignment stops accepting work: its due date if late work is refused, its late window's close, or never. */
function closesAt(assignment: AssignmentBinding): string | undefined {
  if (assignment.latePolicy.kind === "refuse") return assignment.dueAt;
  return assignment.latePolicy.closesAt;
}

/** What the grading adapter acts through, for one request. */
export interface QuizGradingServices {
  records: AssessmentRecordStore;
  assessment: AssessmentService;
  artifacts: LearningArtifacts;
  workspaces: WorkspaceDirectory;
  /** The request's correlation ID, so every decision the quiz causes is audited under it. */
  correlationId: string;
}

/** {@link QuizGrading} over the district's assessment, artifact and workspace services. */
export function quizGrading({ records, assessment, artifacts, workspaces, correlationId }: QuizGradingServices): QuizGrading {
  const callerOf = (subject: VerifiedPrincipal): Caller => ({ principal: subject, channel: "http", correlationId });
  return {
    async assignment(offeringId, assignmentId): Promise<QuizAssignment | undefined> {
      const assignment = (await records.load()).state.assignments.find((a) => a.id === assignmentId && a.offeringId === offeringId);
      if (assignment === undefined) return undefined;
      const closes = closesAt(assignment);
      return { id: assignment.id, title: assignment.title, ...(closes === undefined ? {} : { closesAt: closes }) };
    },

    async prepareAssignment(subject, assignmentId, attemptsAllowed) {
      const caller = callerOf(subject);
      const { assignment } = await assessment.getAssignment(caller, assignmentId as AssignmentBinding["id"]);
      const types = assignment.permittedArtifactTypes.includes(ANSWER_SHEET_TYPE) ? undefined : [...assignment.permittedArtifactTypes, ANSWER_SHEET_TYPE];
      const attempts = assignment.attemptsAllowed >= attemptsAllowed ? undefined : attemptsAllowed;
      if (types === undefined && attempts === undefined) return;
      await assessment.updateAssignment(caller, assignment.id, {
        ...(types === undefined ? {} : { permittedArtifactTypes: types }),
        ...(attempts === undefined ? {} : { attemptsAllowed: attempts }),
      });
    },

    async submitAnswerSheet(subject, assignmentId, sheet) {
      const caller = callerOf(subject);
      const workspace = await workspaces.ensureCourseWorkspace(caller, sheet.offeringId);
      // The sheet's title names the attempt, so submitting it again finds the sheet already saved
      // and E01 answers with the same submission rather than using another attempt.
      const saved = (await artifacts.listArtifacts(caller, workspace.id)).find((view) => view.artifact.title === sheet.title && view.artifact.type === ANSWER_SHEET_TYPE);
      const view = saved ?? (await artifacts.createArtifact(caller, {
        workspaceId: workspace.id,
        type: ANSWER_SHEET_TYPE,
        title: sheet.title,
        content: { kind: "text", mediaType: "text/markdown", text: sheet.text },
        aiAssistance: { level: "none" },
      }));
      const receipt = await assessment.submit(caller, assignmentId as AssignmentBinding["id"], [{ artifactId: view.artifact.id, revisionId: view.head.id }]);
      return receipt.submissionId;
    },

    async recordGrades(subject, grades) {
      const outcomes = await assessment.recordOfficialGrades(callerOf(subject), grades.map((grade) => ({
        submissionId: grade.submissionId as Parameters<AssessmentService["recordOfficialGrade"]>[1]["submissionId"],
        score: { points: grade.points, maxPoints: grade.maxPoints },
      })));
      return outcomes.map((outcome) => (outcome.status === "official" ? { status: "official" as const, version: outcome.version.version } : { status: "pending-approval" as const }));
    },
  };
}
