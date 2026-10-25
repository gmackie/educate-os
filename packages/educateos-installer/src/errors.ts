import { type ErrorCode, EducateOsError } from "@educateos/contracts";
import type { TokenProvider } from "./token.ts";

/**
 * A failed Cloudflare API call. The message names the operation, the HTTP status and Cloudflare's
 * numeric error codes only: never the token, a request body, or Cloudflare's free-text message,
 * which can quote request input back.
 */
export class CloudflareApiError extends EducateOsError {
  /** The port operation that failed, e.g. `createKvNamespace`. */
  readonly operation: string;
  /** The HTTP status, or 0 when no response arrived. */
  readonly status: number;
  /** Cloudflare's numeric error codes from the response envelope. */
  readonly cloudflareCodes: readonly number[];

  constructor(operation: string, status: number, cloudflareCodes: readonly number[]) {
    super(codeFor(status, cloudflareCodes), describe(operation, status, cloudflareCodes));
    this.name = "CloudflareApiError";
    this.operation = operation;
    this.status = status;
    this.cloudflareCodes = cloudflareCodes;
  }
}

// Cloudflare error codes that mean the credential itself is unusable (invalid, expired or
// revoked), seen alongside 400 as well as 401. Unverified beyond 401 itself; see
// docs/educateos/installer-permissions.md.
const CREDENTIAL_CODES = new Set([1000, 6003, 6111, 9106, 9109, 10001]);

function codeFor(status: number, codes: readonly number[]): ErrorCode {
  if (status === 401 || codes.some((code) => CREDENTIAL_CODES.has(code))) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "validation-failed";
  return "unavailable";
}

function describe(operation: string, status: number, codes: readonly number[]): string {
  const suffix = codes.length > 0 ? ` (Cloudflare codes ${codes.join(", ")})` : "";
  return status === 0 ? `${operation}: no response from Cloudflare` : `${operation}: HTTP ${status}${suffix}`;
}

/**
 * True when a failure means the installer's credential no longer works or lacks a permission: a
 * revoked OAuth grant, a deleted API token, or a missing scope. The reconciler stops at the first
 * one rather than retrying or trying other operations.
 */
export function isCredentialFailure(error: unknown): error is CloudflareApiError {
  return error instanceof CloudflareApiError && (error.code === "unauthenticated" || error.code === "forbidden");
}

/**
 * Gets a token from a provider for one operation. A provider that can no longer produce one (a
 * refused OAuth refresh, an unset environment variable) fails the operation as a 401 would, so
 * the reconciler stops on it the same way.
 */
export async function providerToken(tokens: TokenProvider, operation: string): Promise<string> {
  try {
    return await tokens.accessToken();
  } catch (error) {
    if (error instanceof EducateOsError && error.code === "unauthenticated") throw new CloudflareApiError(operation, 401, []);
    throw error;
  }
}

/** Thrown when the installer stops because its credential failed. Nothing after that call ran. */
export class InstallerHaltedError extends EducateOsError {
  /** The Cloudflare failure that stopped the run. */
  readonly failure: CloudflareApiError;

  constructor(failure: CloudflareApiError) {
    super(failure.code, `installer stopped: ${failure.message}; no further changes were attempted`);
    this.name = "InstallerHaltedError";
    this.failure = failure;
  }
}
