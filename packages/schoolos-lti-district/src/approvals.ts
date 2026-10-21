import type { DistrictId } from "@schoolos/contracts";
import type { AssessmentRecordStore } from "@schoolos/assessment";
import { TeacherGradeApproval, type GradeApprovalKey, type GradeApprovalStore } from "@schoolos/lti";
import type { GradeColumnStore } from "./columns.ts";

/** What {@link OfficialGradeApprovals} reads. */
export interface OfficialGradeApprovalsOptions {
  readonly districtId: DistrictId;
  /** Which assignment each gradebook column carries. */
  readonly columns: GradeColumnStore;
  /** The assessment service's records (E01), where official grade versions are kept. */
  readonly assessments: AssessmentRecordStore;
}

/**
 * The passback gate's {@link GradeApprovalStore}, backed by E01's teacher-approved
 * `OfficialGradeVersion`s. A version exists only because a teacher of the offering approved it
 * directly (policy rule `grade.official.teacher-direct`), so an AI-suggested score, a proposal no
 * teacher approved, or a score from a column bound to another assignment finds no approval.
 *
 * The approval is read from the assessment records on every passback; nothing a caller passes is
 * taken as one.
 */
export class OfficialGradeApprovals implements GradeApprovalStore {
  readonly #options: OfficialGradeApprovalsOptions;

  constructor(options: OfficialGradeApprovalsOptions) {
    this.#options = options;
  }

  async find(key: GradeApprovalKey): Promise<TeacherGradeApproval | undefined> {
    const { districtId } = this.#options;
    const assignmentId = await this.#options.columns.assignmentFor(key.offeringId, key.column);
    if (assignmentId === undefined) return undefined;
    const { state } = await this.#options.assessments.load();
    const assignment = state.assignments.find((a) => a.id === assignmentId);
    if (assignment === undefined || assignment.districtId !== districtId || assignment.offeringId !== key.offeringId) return undefined;
    const version = state.gradeVersions.find(
      (v) =>
        v.districtId === districtId &&
        v.offeringId === key.offeringId &&
        v.assignmentId === assignmentId &&
        v.studentPrincipalId === key.studentId &&
        v.version === key.gradeVersion,
    );
    if (version === undefined) return undefined;
    return TeacherGradeApproval.parse({
      offeringId: version.offeringId,
      studentId: version.studentPrincipalId,
      column: key.column,
      gradeVersion: version.version,
      scoreGiven: version.score.points,
      scoreMaximum: version.score.maxPoints,
      approverId: version.approval.approvedBy,
      approvedAt: version.approval.approvedAt,
    });
  }
}
