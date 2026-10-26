// What every HTTP roster client shares: reading a size-capped JSON body, and discarding one that
// will not be read. Extracted from the OneRoster REST client so the Clever client reads responses
// the same way.
import { RosterSyncError } from "./sync-run.ts";

/** Reads a body as JSON, refusing it once it passes `maxBytes` without buffering the rest. */
export async function readJson(what: string, response: Response, maxBytes: number): Promise<unknown> {
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
