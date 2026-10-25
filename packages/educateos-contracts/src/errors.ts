import { z } from "zod";
import { VerifiedIdentity } from "./identity.ts";

/**
 * The error codes EducateOS services return to callers. A denied read of something the caller may
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

/**
 * The issuer and subject of the caller's own verified sign-in. The subject is what the admin
 * console calls the person's sign-in ID, and the issuer is the provider they signed in through:
 * together, what an administrator enters to add them.
 */
export const UnlinkedSignIn = VerifiedIdentity.pick({ issuer: true, subject: true });
/** An unlinked sign-in. */
export type UnlinkedSignIn = z.infer<typeof UnlinkedSignIn>;

/** The error body every EducateOS HTTP route and MCP tool returns. */
export const EducateOsErrorBody = z.strictObject({
  code: ErrorCode,
  /** Safe to show the caller. Never contains another principal's data, a prompt or a secret. */
  message: z.string().max(1000),
  /** An opaque ID that lets an administrator find the matching audit entry. */
  correlationId: z.string().min(1).max(128).optional(),
  /**
   * Present only on the `unauthenticated` error for a sign-in that verified but is linked to no
   * principal in the district (see {@link UnlinkedSignInError}): the caller's own identity, so they
   * can give it to an administrator. It never appears on any other error, and never for a caller
   * whose credential did not verify.
   */
  unlinkedSignIn: UnlinkedSignIn.optional(),
});
/** An error body. */
export type EducateOsErrorBody = z.infer<typeof EducateOsErrorBody>;

/** An error carrying a {@link EducateOsErrorBody}, thrown by services and serialized at the boundary. */
export class EducateOsError extends Error {
  /** The error's code. */
  readonly code: ErrorCode;
  /** The correlation ID, when the failure was audited. */
  readonly correlationId: string | undefined;

  constructor(code: ErrorCode, message: string, correlationId?: string) {
    super(message);
    this.name = "EducateOsError";
    this.code = code;
    this.correlationId = correlationId;
  }

  /** The body to return to the caller. */
  toBody(): EducateOsErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
    };
  }
}

/**
 * The `unauthenticated` error for a verified sign-in that no principal in the district is linked
 * to. Its body carries the caller's own issuer and subject as `unlinkedSignIn`. Throw it only with
 * an identity that has been verified, since the body shows it to whoever sent the request.
 */
export class UnlinkedSignInError extends EducateOsError {
  /** The caller's verified issuer and subject. */
  readonly signIn: UnlinkedSignIn;

  constructor(signIn: UnlinkedSignIn, message: string) {
    super("unauthenticated", message);
    this.name = "UnlinkedSignInError";
    this.signIn = { issuer: signIn.issuer, subject: signIn.subject };
  }

  override toBody(): EducateOsErrorBody {
    return { ...super.toBody(), unlinkedSignIn: { ...this.signIn } };
  }
}
