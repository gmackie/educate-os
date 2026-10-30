// The errors sessions throw. Each carries the `code` a tool call reports it with. Messages never
// carry a token or a provider's response body.

/** The tool-call error codes `CleverToolCallResult` documents. */
export type CleverErrorCode = "forbidden" | "not-found" | "validation-failed" | "unavailable";

/** A refusal or failure a session reports, with the code its tool call answers. */
export class CleverError extends Error {
  readonly code: CleverErrorCode;

  constructor(code: CleverErrorCode, message: string) {
    super(message);
    this.name = "CleverError";
    this.code = code;
  }
}

/**
 * A record that does not exist, or one the signed-in user may not reach: the two answer alike, so
 * that a refusal says nothing about what exists.
 */
export function notFound(what: string): CleverError {
  return new CleverError("not-found", `No such ${what}, or you may not see it.`);
}

export function invalid(message: string): CleverError {
  return new CleverError("validation-failed", message);
}

export function forbidden(message: string): CleverError {
  return new CleverError("forbidden", message);
}

export function unavailable(message: string): CleverError {
  return new CleverError("unavailable", message);
}

/** The code an arbitrary error answers a tool call with. */
export function codeOf(error: unknown): CleverErrorCode {
  if (error instanceof CleverError) return error.code;
  // An error rebuilt across RPC keeps its own enumerable `code`.
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "forbidden" || code === "not-found" || code === "validation-failed" || code === "unavailable") {
    return code;
  }
  return "unavailable";
}
