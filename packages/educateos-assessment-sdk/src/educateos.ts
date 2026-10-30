import { z } from "zod";
import { ArtifactId, AssessmentRunId, SubmissionId, type Caller } from "@educateos/contracts";
import type { AssessmentService } from "@educateos/assessment";
import type { AssessmentCi } from "@educateos/assessment-ci";

const submissionRequest = z.strictObject({ submissionId: SubmissionId });
const evidenceRequest = submissionRequest.extend({ artifactId: ArtifactId });
const reportRequest = submissionRequest.extend({ runId: AssessmentRunId });

/** Server-side dependencies for the optional EducateOS read adapter. */
export interface EducateOsReaderOptions {
  /** The real district service remains the authority for access and pinned artifact integrity. */
  assessment: AssessmentService;
  /** The real CI service applies its teacher/student report projection. */
  ci: AssessmentCi;
  /**
   * Resolve the authenticated caller from trusted host session state on EVERY operation.
   * Never derive this from an SDK request body or accept a client-supplied role or channel.
   */
  caller(): Caller | Promise<Caller>;
}

/**
 * Bind a read-only SDK view to the existing EducateOS services. This is a server-side capability,
 * not an authentication mechanism. There are deliberately no grade, feedback-write, or execution
 * methods: grade proposals and approvals continue through AssessmentService's existing policy.
 * Domain records and reports retain their existing types; they are not portable blueprint content.
 */
export function createEducateOsReader(options: EducateOsReaderOptions) {
  // Capture dependencies so mutating the options object cannot replace a reader's authority.
  const { assessment, ci, caller } = options;
  return Object.freeze({
    /** Read a snapshot through the district's submission visibility policy. */
    async submission(raw: unknown) {
      const request = submissionRequest.parse(raw);
      return assessment.getSubmission(await caller(), request.submissionId);
    },
    /** Read the exact submitted artifact revision, verified by the district content service. */
    async evidence(raw: unknown) {
      const request = evidenceRequest.parse(raw);
      return assessment.readSubmittedContent(await caller(), request.submissionId, request.artifactId);
    },
    /** Read a report with the existing teacher-only checks and student projection preserved. */
    async report(raw: unknown) {
      const request = reportRequest.parse(raw);
      return ci.view(await caller(), request.submissionId, request.runId);
    },
    /** Read feedback using the service's release state and suggestion visibility rules. */
    async feedback(raw: unknown) {
      const request = submissionRequest.parse(raw);
      return assessment.getFeedback(await caller(), request.submissionId);
    },
  });
}

/** The read capability, derived from the factory rather than mirroring RPC or service interfaces. */
export type EducateOsReader = ReturnType<typeof createEducateOsReader>;
