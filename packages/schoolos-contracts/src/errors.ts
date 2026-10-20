import { z } from "zod";

/**
 * The error codes SchoolOS services return to callers. A denied read of something the caller may
 * not know exists returns `not-found`, not `forbidden`, so that probing another student's artifact
 * IDs reveals nothing. `forbidden` is for resources the caller can already see but may not act on.
 * The reason a request was denied goes to the audit log (see `DecisionReason`), never to the
 * response.
 */
export const ErrorCode = z.enum([
  "unauthenticated",
  "forbidden",
  "not-found",
  "conflict",
  "validation-failed",
  "policy-violation",
  "budget-exceeded",
  "unavailable",
]);
/** An error code. */
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The error body every SchoolOS HTTP route and MCP tool returns. */
export const SchoolOsErrorBody = z.strictObject({
  code: ErrorCode,
  /** Safe to show the caller. Never contains another principal's data, a prompt or a secret. */
  message: z.string().max(1000),
  /** An opaque ID that lets an administrator find the matching audit entry. */
  correlationId: z.string().min(1).max(128).optional(),
});
/** An error body. */
export type SchoolOsErrorBody = z.infer<typeof SchoolOsErrorBody>;

/** An error carrying a {@link SchoolOsErrorBody}, thrown by services and serialized at the boundary. */
export class SchoolOsError extends Error {
  /** The error's code. */
  readonly code: ErrorCode;
  /** The correlation ID, when the failure was audited. */
  readonly correlationId: string | undefined;

  constructor(code: ErrorCode, message: string, correlationId?: string) {
    super(message);
    this.name = "SchoolOsError";
    this.code = code;
    this.correlationId = correlationId;
  }

  /** The body to return to the caller. */
  toBody(): SchoolOsErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
    };
  }
}
