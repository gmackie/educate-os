// Google's JSON error responses, as Google APIs serve them. Followed: Google AIP-193 (Errors) and
// the Cloud API error model (https://cloud.google.com/apis/design/errors): a body of
// `{error: {code, message, status, details}}` with a `google.rpc.ErrorInfo` detail naming a
// machine-readable `reason`; and the Classroom API's habit of prefixing its own error codes to the
// message (`@ProjectPermissionDenied ...`, `@ClassroomApiDisabled ...`), which the Classroom
// documentation's "Access errors" and "Request errors" guides describe.
import type { HeadersSource } from "../types.ts";

/** The `google.rpc.Code` names this fake answers with. */
export type GoogleStatus =
  | "INVALID_ARGUMENT" | "UNAUTHENTICATED" | "PERMISSION_DENIED" | "NOT_FOUND" | "FAILED_PRECONDITION" | "RESOURCE_EXHAUSTED"
  | "INTERNAL" | "UNAVAILABLE" | "DEADLINE_EXCEEDED";

/** A `google.rpc.ErrorInfo` detail. */
export interface ErrorInfo {
  readonly reason: string;
  readonly domain?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A Google API error response. */
export function googleErrorResponse(code: number, status: GoogleStatus, message: string, options: { info?: ErrorInfo; headers?: HeadersSource } = {}): Response {
  const details = options.info === undefined
    ? undefined
    : [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: options.info.reason, domain: options.info.domain ?? "googleapis.com", ...(options.info.metadata === undefined ? {} : { metadata: options.info.metadata }) }];
  return Response.json(
    { error: { code, message, status, ...(details === undefined ? {} : { details }) } },
    { status: code, ...(options.headers === undefined ? {} : { headers: options.headers }) },
  );
}

/** Thrown inside the fake to answer with a Google error. */
export class GoogleError extends Error {
  override readonly name = "GoogleError";
  readonly code: number;
  readonly status: GoogleStatus;
  readonly info: ErrorInfo | undefined;
  readonly headers: HeadersSource | undefined;

  constructor(code: number, status: GoogleStatus, message: string, info?: ErrorInfo, headers?: HeadersSource) {
    super(message);
    this.code = code;
    this.status = status;
    this.info = info;
    this.headers = headers;
  }

  /** The error as a response. */
  response(): Response {
    return googleErrorResponse(this.code, this.status, this.message, {
      ...(this.info === undefined ? {} : { info: this.info }),
      ...(this.headers === undefined ? {} : { headers: this.headers }),
    });
  }
}
