// The SPA's client for the admin Worker's /api. Access attaches the sign-in cookie itself, so the
// client only sends same-origin JSON.
import type { AdminErrorBody } from "../../shared/api.ts";

/** A failed call, with a message safe to show. */
export class AdminApiError extends Error {
  override readonly name = "AdminApiError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The admin API. */
export interface AdminClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

/** A client over `fetch` (the browser's, or a fake in tests). */
export function createAdminClient(fetcher: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)): AdminClient {
  const send = async <T>(path: string, init: RequestInit): Promise<T> => {
    let response: Response;
    try {
      response = await fetcher(path, { credentials: "same-origin", ...init, headers: { accept: "application/json", ...init.headers } });
    } catch {
      throw new AdminApiError(0, "unreachable", "The admin could not be reached. Check your connection.");
    }
    const body = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      const error = body as Partial<AdminErrorBody> | undefined;
      throw new AdminApiError(response.status, error?.code ?? "error", error?.message ?? `The admin answered ${response.status}.`);
    }
    return body as T;
  };
  return {
    get: (path) => send(path, { method: "GET" }),
    post: (path, body) => send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
  };
}
