import { SchoolOsErrorBody, type ErrorCode } from "@schoolos/contracts";
import {
  ROUTES,
  routePath,
  type RouteInput,
  type RouteName,
  type RouteResponse,
  type RouteSpec,
} from "@schoolos/district-app/routes";

export type { RouteInput, RouteName, RouteResponse, UploadMediaType } from "@schoolos/district-app/routes";
/** The file types and size a district accepts as uploaded work, so a UI can refuse a file before sending it. */
export { MAX_UPLOAD_BYTES, UPLOAD_MEDIA_TYPES } from "@schoolos/district-app/routes";

/** The header the district app returns each request's correlation ID in. */
const CORRELATION_HEADER = "x-correlation-id";

/** A district API error: the server's `SchoolOsErrorBody`, its HTTP status and correlation ID. */
export class DistrictApiError extends Error {
  /** The error code. */
  readonly code: ErrorCode;
  /** The HTTP status. */
  readonly status: number;
  /** The ID an administrator can find the request's audit entries by. */
  readonly correlationId: string | undefined;

  constructor(status: number, body: SchoolOsErrorBody) {
    super(body.message);
    this.name = "DistrictApiError";
    this.code = body.code;
    this.status = status;
    this.correlationId = body.correlationId;
  }
}

/** How a {@link DistrictApiClient} reaches the district. */
export interface DistrictApiClientOptions {
  /** The district's origin, such as `https://learn.northfield.example`. */
  baseUrl: string | URL;
  /**
   * The bearer credential, or a function that returns the current one. Omit it where the platform
   * attaches the credential itself, as Cloudflare Access does with its cookie.
   */
  token?: string | (() => string | Promise<string>);
  /** The fetch to send requests with. Defaults to the global `fetch`. */
  fetch?: (request: Request) => Promise<Response>;
}

/** The arguments a route takes: none when every part of its input may be omitted. */
export type CallArgs<N extends RouteName> = {} extends RouteInput<N> ? [input?: RouteInput<N>] : [input: RouteInput<N>];

/** A typed client for one district's API. */
export interface DistrictApiClient {
  /**
   * Calls a route by name. Resolves with the response parsed by the route's schema, or rejects
   * with a {@link DistrictApiError} carrying the server's error body.
   */
  call<N extends RouteName>(name: N, ...args: CallArgs<N>): Promise<RouteResponse<N>>;
}

/** Creates a client for the district at `options.baseUrl`. */
export function createDistrictApiClient(options: DistrictApiClientOptions): DistrictApiClient {
  const send = options.fetch ?? ((request: Request) => fetch(request));
  return {
    async call<N extends RouteName>(name: N, ...args: CallArgs<N>): Promise<RouteResponse<N>> {
      const spec: RouteSpec = ROUTES[name];
      const input = (args[0] ?? {}) as { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown };
      const url = new URL(routePath(spec.path, input.params), options.baseUrl);
      for (const [key, value] of Object.entries(input.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);

      const headers = new Headers({ accept: "application/json" });
      const token = typeof options.token === "function" ? await options.token() : options.token;
      if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
      if (spec.method === "POST") headers.set("content-type", "application/json");
      const response = await send(new Request(url, {
        method: spec.method,
        headers,
        ...(spec.method === "POST" ? { body: JSON.stringify(input.body ?? {}) } : {}),
      }));

      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const error = SchoolOsErrorBody.safeParse(body);
        throw new DistrictApiError(response.status, error.success
          ? error.data
          : { code: "unavailable", message: `The district answered ${response.status}.`, ...correlation(response) });
      }
      const parsed = spec.response.safeParse(body);
      if (!parsed.success) {
        throw new DistrictApiError(response.status, { code: "unavailable", message: `The district's ${name} response did not match its schema.`, ...correlation(response) });
      }
      return parsed.data as RouteResponse<N>;
    },
  };
}

function correlation(response: Response): { correlationId?: string } {
  const id = response.headers.get(CORRELATION_HEADER);
  return id === null || id === "" ? {} : { correlationId: id.slice(0, 128) };
}
