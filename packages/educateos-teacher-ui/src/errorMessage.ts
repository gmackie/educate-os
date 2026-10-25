import { DistrictApiError } from "@educateos/api-client";

/** What went wrong, in words a teacher can act on, and a reference their district's help desk can trace. */
export interface ProblemText {
  message: string;
  detail?: string;
  reference?: string;
}

const BY_CODE: Partial<Record<DistrictApiError["code"], string>> = {
  unauthenticated: "Your sign-in has expired. Sign in again to continue.",
  forbidden: "You don't have permission to do that in this class.",
  "not-found": "We couldn't find that. It may have been removed, or it isn't part of your class.",
  conflict: "Someone changed this while you were working. Reload to see the latest.",
  "validation-failed": "Some details need fixing before this can be saved.",
  "policy-violation": "Your district's policy doesn't allow that.",
  "budget-exceeded": "This class has used its AI allowance for now.",
};

/** Turns a failed call into a {@link ProblemText}. */
export const describeProblem = (error: unknown): ProblemText => {
  if (!(error instanceof DistrictApiError)) return { message: "Something went wrong. Check your connection and try again." };
  const message = BY_CODE[error.code] ?? "The district didn't answer. Try again in a moment.";
  // Validation and policy messages name the field or rule at fault, which is what the teacher needs to fix it.
  const detail = error.code === "validation-failed" || error.code === "policy-violation" || error.code === "conflict" ? error.message : undefined;
  return { message, ...(detail === undefined ? {} : { detail }), ...(error.correlationId === undefined ? {} : { reference: error.correlationId }) };
};
