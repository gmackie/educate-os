// The live target of the district validation suite (SCHO-205): read-only probes of a deployed demo
// district at `https://<slug>.educateos.io`, behind Cloudflare Access. It sends GET requests only,
// follows no redirect, and never signs anyone in or writes anything.
//
// Today it is a stub over what a deployed district already exposes: its liveness probe, Access in
// front of its API, and the LTI Tool endpoints an LMS must reach without Access. A request with an
// Access service token (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) also checks that Access
// admits the suite. The integration scenarios need the provider fakes deployed beside each district
// and a way for the suite to act as a person there, which is SCHO-210; until then they are
// reported NOT YET APPLICABLE.
import { DEMO_DISTRICTS, demoDistrict, type DemoDistrictSlug } from "@educateos/fixtures";
import { SCENARIOS } from "./districts.ts";
import type { CellStatus, DistrictReport, ReportCell } from "./district-report.ts";

/** An Access service token, sent as Access's two headers. */
export interface ServiceToken {
  clientId: string;
  clientSecret: string;
}

/** What the live target was given. */
export interface LiveOptions {
  /** The district's origin, `https://<slug>.educateos.io`. */
  target: string;
  /** An Access service token, if one is configured. */
  serviceToken?: ServiceToken;
  /** The fetch to probe with. */
  fetch?: typeof fetch;
  generatedAt?: string;
  revision?: string;
}

/** A probe that only the live target has, alongside the in-process scenarios. */
export const LIVE_PROBES = [
  { id: "live-healthz", title: "the district's liveness probe answers without sign-in" },
  { id: "live-access-gate", title: "the district's API is behind Cloudflare Access: an unauthenticated request is sent to Access sign-in, never served" },
  { id: "live-service-token", title: "Access admits the validation suite's service token to the API" },
  { id: "live-lti-public", title: "the LTI Tool's JWKS is served without Access, as an LMS must reach it" },
] as const;

const DEPLOY = "SCHO-210";

/** The demo district a live origin serves: the first label of `<slug>.educateos.io`. */
export function districtOfTarget(target: string): DemoDistrictSlug {
  const url = new URL(target);
  if (url.protocol !== "https:") throw new Error(`a live target is an https origin, not ${target}`);
  // Exactly `<slug>.educateos.io`: a service token is sent to this host, so a look-alike is refused.
  const demo = DEMO_DISTRICTS.find((d) => url.hostname === `${d.slug}.educateos.io`);
  if (demo === undefined || url.port !== "") throw new Error(`${url.host} is not a demo district at <slug>.educateos.io`);
  return demo.slug;
}

/** The service token from the environment, if both halves are set. */
export function serviceTokenFromEnv(env: NodeJS.ProcessEnv): ServiceToken | undefined {
  const clientId = env["CF_ACCESS_CLIENT_ID"];
  const clientSecret = env["CF_ACCESS_CLIENT_SECRET"];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Whether a response is Cloudflare Access sending the request to its sign-in. */
const isAccessLogin = (response: Response, origin: string) =>
  response.status >= 300 && response.status < 400 && (redirectOf(response, origin)?.hostname.endsWith(".cloudflareaccess.com") ?? false);

/** Where a response redirects, resolved against the request's origin (a `Location` may be relative). */
function redirectOf(response: Response, origin: string): URL | undefined {
  const location = response.headers.get("location");
  if (location === null) return undefined;
  try {
    return new URL(location, origin);
  } catch {
    return undefined;
  }
}

/** Why a probe failed: the error, or the status and where it redirected (its origin only). */
function failed(what: string, got: Response | Error, origin: string): string {
  if (got instanceof Error) return `${what}: ${got.message}`;
  const to = redirectOf(got, origin);
  return `${what}: HTTP ${got.status}${to === undefined ? "" : ` to ${to.origin}`}`;
}

/** Runs the probes against a deployed district and reports them with the scenarios, one column. */
export async function liveReport(options: LiveOptions): Promise<DistrictReport> {
  const origin = new URL(options.target).origin;
  const slug = districtOfTarget(origin);
  const demo = demoDistrict(slug);
  const probe = options.fetch ?? fetch;
  const get = async (path: string, headers: Record<string, string> = {}) => {
    try {
      return await probe(`${origin}${path}`, { method: "GET", redirect: "manual", headers });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const cells: ReportCell[] = [];
  const add = (scenario: string, status: CellStatus, note?: string, blockedBy?: readonly string[]) =>
    cells.push({ district: slug, scenario, status, ...(note === undefined ? {} : { note }), ...(blockedBy === undefined ? {} : { blockedBy }) });

  const healthz = await get("/healthz");
  const healthy = !(healthz instanceof Error) && healthz.status === 200 && (await healthz.text()).trim() === "ok";
  add("live-healthz", healthy ? "MET" : "NOT MET", healthy ? undefined : failed("GET /healthz", healthz, origin));

  const me = await get("/api/me");
  // Only Access's own redirect counts: a 401 from the district app would mean Access is not in front.
  const gated = !(me instanceof Error) && isAccessLogin(me, origin);
  add("live-access-gate", gated ? "MET" : "NOT MET", gated ? undefined : failed("GET /api/me without credentials was not sent to Access sign-in", me, origin));

  if (options.serviceToken === undefined) {
    add("live-service-token", "NOT YET APPLICABLE", "No Access service token is configured. It needs a service token with a Service Auth policy on the district's Access application, given to the suite as CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.", [DEPLOY]);
  } else {
    const admitted = await get("/api/me", { "CF-Access-Client-Id": options.serviceToken.clientId, "CF-Access-Client-Secret": options.serviceToken.clientSecret });
    // Access admitted it if the district itself answered: not a redirect, not Access's 403, not a server error.
    const ok = !(admitted instanceof Error) && admitted.status < 500 && !(admitted.status >= 300 && admitted.status < 400) && admitted.status !== 403;
    add("live-service-token", ok ? "MET" : "NOT MET", ok ? undefined : failed("GET /api/me with the service token", admitted, origin));
  }

  if (demo.profile.lms === "canvas-lti" || demo.profile.lms === "schoology-lti") {
    const jwks = await get("/lti/jwks");
    let keys = 0;
    if (!(jwks instanceof Error) && jwks.status === 200) keys = ((await jwks.json().catch(() => ({}))) as { keys?: unknown[] }).keys?.length ?? 0;
    add("live-lti-public", keys > 0 ? "MET" : "NOT MET", keys > 0 ? undefined : failed("GET /lti/jwks was not served without Access, so an LMS cannot launch the tool", jwks, origin));
  } else {
    add("live-lti-public", "NOT IN PROFILE");
  }

  for (const scenario of SCENARIOS) {
    if (scenario.applies(demo).kind === "not-in-profile") add(scenario.id, "NOT IN PROFILE");
    else add(scenario.id, "NOT YET APPLICABLE", "The live district has no deployed provider fakes and the suite cannot act as a person there yet.", [DEPLOY]);
  }
  return { target: origin, generatedAt: options.generatedAt ?? new Date().toISOString(), ...(options.revision === undefined ? {} : { revision: options.revision }), cells };
}
