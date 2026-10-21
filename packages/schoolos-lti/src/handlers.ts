import { z } from "zod";
import { ActivityId, SchoolOsError, type ErrorCode } from "@schoolos/contracts";
import { LOGIN_STATE_TTL_MS, type LtiBroker, type ResolvedLaunch } from "./broker.ts";
import type { DeepLinkSelection } from "./deep-linking.ts";

/** What the host application supplies around the broker. */
export interface LtiHandlerOptions {
  readonly broker: LtiBroker;
  /** Answers an accepted resource link launch, typically by starting a session and redirecting. */
  onResourceLinkLaunch(launch: ResolvedLaunch): Promise<Response>;
  /**
   * Answers an accepted deep linking request, typically with a content picker that later posts
   * `session` and one `activity` field per choice to `/lti/deep-link`.
   */
  onDeepLinkingRequest(launch: ResolvedLaunch, session: string): Promise<Response>;
  /**
   * Authorizes and labels the activities a principal chose. It must check that the launch's
   * principal may place each activity in the launch's offering, and throw a `SchoolOsError` to
   * refuse.
   */
  selectActivities(launch: ResolvedLaunch, activityIds: readonly ActivityId[]): Promise<readonly DeepLinkSelection[]>;
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  "validation-failed": 400,
  "policy-violation": 403,
  "budget-exceeded": 402,
  unavailable: 503,
};

const NO_STORE = { "cache-control": "no-store" };

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...NO_STORE } });

/**
 * The browser-binding cookie for a login state. Its name carries the state, so concurrent launches
 * in several tabs do not overwrite each other. Without it, a launch is refused: otherwise an
 * attacker could start a login, receive an id_token for their own account, and post it from the
 * victim's browser to sign the victim in as the attacker. `SameSite=None` and `Partitioned` let it
 * work inside the platform's iframe.
 */
const stateCookieName = (state: string): string => `__Host-lti-state-${state}`;

const StateLike = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

function hasCookie(request: Request, name: string): boolean {
  const header = request.headers.get("cookie") ?? "";
  return header.split(";").some((pair) => pair.trim().split("=", 1)[0] === name);
}

const LaunchForm = z.object({ id_token: z.string().min(1).max(16_384), state: StateLike });
const DeepLinkForm = z.object({ session: StateLike, activity: z.array(ActivityId).max(50) });

async function formFields(request: Request): Promise<Record<string, string[]>> {
  const fields: Record<string, string[]> = {};
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new SchoolOsError("validation-failed", "Expected a form post.");
  }
  for (const [name, value] of form) if (typeof value === "string") (fields[name] ??= []).push(value);
  return fields;
}

const single = (fields: Record<string, string[]>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(fields).map(([name, values]) => [name, values.length === 1 ? values[0] : undefined]));

/**
 * Fetch-standard handlers for the tool's LTI endpoints. Returns `undefined` for any other path, so
 * a Worker can fall through to its other routes.
 *
 * - `GET|POST /lti/login`: OIDC third-party login initiation; redirects to the platform.
 * - `POST /lti/launch`: the platform's form post of `id_token` and `state`.
 * - `GET /lti/jwks`: the tool's public keys.
 * - `POST /lti/deep-link`: the content picker's choice; answers with a page that posts the signed
 *   deep linking response back to the platform.
 */
export function createLtiHandler(options: LtiHandlerOptions): (request: Request) => Promise<Response | undefined> {
  const { broker } = options;
  type Handler = (request: Request) => Promise<Response>;
  const routes = new Map<string, Map<string, Handler>>([
    ["/lti/login", new Map([["GET", login], ["POST", login]])],
    ["/lti/launch", new Map([["POST", launch]])],
    ["/lti/jwks", new Map([["GET", async () => json(broker.jwks(), 200)]])],
    ["/lti/deep-link", new Map([["POST", deepLink]])],
  ]);

  async function login(request: Request): Promise<Response> {
    const params =
      request.method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : single(await formFields(request));
    const { redirectUrl, state } = await broker.login(params);
    const cookie = `${stateCookieName(state)}=1; Path=/; Max-Age=${LOGIN_STATE_TTL_MS / 1000}; Secure; HttpOnly; SameSite=None; Partitioned`;
    return new Response(null, { status: 302, headers: { location: redirectUrl, "set-cookie": cookie, ...NO_STORE } });
  }

  async function launch(request: Request): Promise<Response> {
    const form = LaunchForm.safeParse(single(await formFields(request)));
    if (!form.success) throw new SchoolOsError("unauthenticated", "The LTI launch is incomplete.");
    const { id_token: idToken, state } = form.data;
    if (!hasCookie(request, stateCookieName(state))) {
      throw new SchoolOsError("unauthenticated", "This LTI launch did not start in this browser.");
    }
    const result = await broker.launch(idToken, state);
    const response =
      result.deepLinkSession === undefined
        ? await options.onResourceLinkLaunch(result.launch)
        : await options.onDeepLinkingRequest(result.launch, result.deepLinkSession);
    const headers = new Headers(response.headers);
    headers.append("set-cookie", `${stateCookieName(state)}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None; Partitioned`);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  async function deepLink(request: Request): Promise<Response> {
    const fields = await formFields(request);
    const form = DeepLinkForm.safeParse({ session: fields.session?.length === 1 ? fields.session[0] : undefined, activity: fields.activity ?? [] });
    if (!form.success || Object.keys(fields).some((name) => name !== "session" && name !== "activity")) {
      throw new SchoolOsError("validation-failed", "The content selection is malformed.");
    }
    const { session, activity } = form.data;
    const result = await broker.completeDeepLink(session, (resolved) => options.selectActivities(resolved, activity));
    return new Response(result.html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } });
  }

  return async (request) => {
    const route = routes.get(new URL(request.url).pathname);
    if (route === undefined) return undefined;
    const handle = route.get(request.method);
    if (handle === undefined) return json({ code: "validation-failed", message: "Method not allowed." }, 405);
    try {
      return await handle(request);
    } catch (err) {
      if (err instanceof SchoolOsError) return json(err.toBody(), HTTP_STATUS[err.code]);
      throw err;
    }
  };
}
