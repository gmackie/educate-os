// Response helpers the Google clients share: a size-capped JSON read, and Google's error body
// reduced to the codes a caller may act on. New for SCHO-77.
import { z } from "zod";
import { RosterSyncError } from "../sync-run.ts";

/** Reads a body as JSON, refusing it once it passes `maxBytes` without buffering the rest. */
export async function readBoundedJson(what: string, response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await discard(response);
    throw new RosterSyncError("response-too-large", `${what} response is larger than ${maxBytes} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RosterSyncError("response-too-large", `${what} response is larger than ${maxBytes} bytes`);
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RosterSyncError("invalid-response", `${what} response is not JSON`);
  }
}

/** Cancels a body that will not be read, freeing the connection. */
export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

const ErrorBody = z.object({
  error: z.object({
    status: z.string().max(64).optional(),
    message: z.string().max(4096).optional(),
    details: z.array(z.object({ reason: z.string().max(128).optional() }).loose()).optional(),
  }).loose(),
});

/**
 * What a Google API error says, reduced to codes: the canonical `status` (`PERMISSION_DENIED`), the
 * `ErrorInfo` reason (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `RATE_LIMIT_EXCEEDED`), and Classroom's
 * own `@` tag at the start of the message (`ProjectPermissionDenied`, `ClassroomApiDisabled`).
 * The message itself is never kept.
 */
export interface GoogleErrorCodes {
  status?: string;
  reasons: string[];
}

/** Reads a Google error body. A body that is not one yields no codes. */
export async function readGoogleError(response: Response): Promise<GoogleErrorCodes> {
  let body: unknown;
  try {
    body = await readBoundedJson("error", response, 64 * 1024);
  } catch {
    return { reasons: [] };
  }
  const parsed = ErrorBody.safeParse(body);
  if (!parsed.success) return { reasons: [] };
  const { status, message, details } = parsed.data.error;
  const tag = message === undefined ? undefined : /^@([A-Za-z]+)\b/.exec(message)?.[1];
  const reasons = [...(details ?? []).flatMap((d) => (d.reason === undefined ? [] : [d.reason])), ...(tag === undefined ? [] : [tag])];
  return { ...(status === undefined ? {} : { status }), reasons };
}
