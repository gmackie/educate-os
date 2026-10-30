// The district's LTI 1.3 Tool (SCHO-177): `@educateos/lti`'s broker and handlers over the district's
// own Durable Object storage (`@educateos/lti-district`), and the administrators' LTI operations.
// Like district.ts, it imports nothing Workers-only, so it is type-checked on the web-standard
// surface (ADR-0009).
//
// Two surfaces, with different sign-in:
//
// - `/lti/*` is the Tool itself: OIDC login initiation, launch, JWKS, the Deep Linking return and
//   Dynamic Registration. A platform's users reach it from their LMS, not through Cloudflare
//   Access, so a deployment exempts exactly these paths from Access. Nothing here trusts the
//   request's origin: a launch is a platform-signed id_token bound to single-use state, a deep
//   link choice needs its single-use session, and registration needs a single-use invitation.
// - `/api/lti/*` is the administrators' surface, behind Access like the rest of `/api`: every
//   request is verified and resolved through the directory, and every call is decided by the
//   district's policy engine.
import { z } from "zod";
import { ERROR_STATUS } from "@educateos/academics";
import { EducateOsError, type ActivityId, type Caller, type DistrictId } from "@educateos/contracts";
import type { DistrictApp, DistrictAppStores, RequestVerifier } from "@educateos/district-app";
import { createDirectoryPrincipalResolver } from "@educateos/identity";
import { recordPendingIdentityLink } from "@educateos/identity-links";
import {
  AgsClient,
  createLtiHandler,
  DynamicRegistration,
  GradePassback,
  LtiAgsGradeSink,
  LtiBroker,
  LtiServiceClient,
  NrpsClient,
  PlatformJwksCache,
  type ResolvedLaunch,
  type ToolKeySet,
} from "@educateos/lti";
import {
  createLtiDistrictStores,
  curriculumActivityCatalog,
  directoryRegistrationTargets,
  districtPrincipalResolver,
  LtiAdminService,
  LtiAdvantageService,
  OfficialGradeApprovals,
  policySelectActivities,
  recordLaunchServices,
  type ActivityCatalog,
} from "@educateos/lti-district";
import { DurableObjectRecordTable, type LtiSqlStorage } from "@educateos/lti-district/durable-object";

/** The name platforms show for the tool when it registers itself. */
export const LTI_TOOL_NAME = "EducateOS";

/** What the district's LTI Tool is built from. */
export interface DistrictLtiOptions {
  /** The district's Durable Object storage, which the LTI records share with the application's. */
  storage: LtiSqlStorage;
  app: DistrictApp;
  stores: DistrictAppStores;
  /** The `/api` sign-in: the same verifier the application uses. */
  verifyRequest: RequestVerifier;
  /** The Tool's public https origin (`LTI_TOOL_ORIGIN`): where platforms send logins and launches. */
  toolOrigin: string;
  /** The fetch platform calls go through: JWKS, tokens, AGS, NRPS and registration. */
  platformFetch: typeof fetch;
  /**
   * The issuers the district signs people in with: its Access team domain and Clever. No platform
   * may register, be trusted or launch under one (SCHO-306).
   */
  reservedIssuers: readonly string[];
}

/** The district's LTI Tool and its administrators' surface. */
export interface DistrictLti {
  /** Serves `/lti/*`, or returns `undefined` for any other path. */
  serveTool(request: Request): Promise<Response | undefined>;
  /** Serves `/api/lti/*` for an Access-verified district principal. */
  serveAdmin(request: Request): Promise<Response>;
}

/** The prefix of the administrators' LTI surface. */
export const LTI_API_PREFIX = "/api/lti/";

/** Starts the district's LTI Tool over its storage. */
export function startDistrictLti(options: DistrictLtiOptions): DistrictLti {
  const { app, stores, toolOrigin } = options;
  const districtId = app.districtId;
  const fetch = options.platformFetch;
  const directory = async () => (await stores.directory.load()).snapshot;
  const activities = curriculumActivityCatalog(stores.curriculum);
  const lti = createLtiDistrictStores(new DurableObjectRecordTable(options.storage), {
    targets: directoryRegistrationTargets({ districtId, directory, activities, reservedIssuers: options.reservedIssuers }),
  });

  // The broker and the service client read keys synchronously; each request first loads the
  // stored set (an imported copy is cached until the stored key IDs change), so a rotation made
  // by any request applies to the next one.
  let keys: ToolKeySet | undefined;
  const currentKeys = (): ToolKeySet => {
    if (keys === undefined) throw new EducateOsError("unavailable", "The tool's keys are not loaded.");
    return keys;
  };
  const loadKeys = async () => {
    keys = await lti.toolKeys.keySet();
  };

  const services = new LtiServiceClient({ fetch, toolKeys: currentKeys });
  const broker = new LtiBroker({
    toolOrigin,
    registrations: lti.registrations,
    loginStates: lti.loginStates,
    deepLinkSessions: lti.deepLinkSessions,
    platformKeys: new PlatformJwksCache({ fetch }),
    toolKeys: currentKeys,
    principalResolver: districtPrincipalResolver(districtId, stores.directory, options.reservedIssuers),
  });
  const dynamicRegistration = new DynamicRegistration({
    toolOrigin,
    toolName: LTI_TOOL_NAME,
    invitations: lti.invitations,
    pending: lti.pendingRegistrations,
    fetch,
  });
  const approvals = new OfficialGradeApprovals({ districtId, columns: lti.gradeColumns, assessments: stores.assessment });
  const admin = new LtiAdminService({
    districtId,
    authorizer: app.engine,
    directory,
    dynamicRegistration,
    pending: lti.pendingRegistrations,
    registrations: lti.registrations,
    contextServices: lti.contextServices,
    gradeRoutes: lti.gradeRoutes,
    gradeColumns: lti.gradeColumns,
    assessments: stores.assessment,
  });
  const advantage = new LtiAdvantageService({
    districtId,
    reservedIssuers: options.reservedIssuers,
    authorizer: app.engine,
    directory: stores.directory,
    registrations: lti.registrations,
    pending: lti.pendingRegistrations,
    contextServices: lti.contextServices,
    lineItems: new AgsClient({ services, registrations: lti.registrations }),
    roster: new NrpsClient({ services, registrations: lti.registrations }),
    passback: new GradePassback({
      districtId,
      directory,
      routes: lti.gradeRoutes,
      approvals,
      ledger: lti.passbackLedger,
      sinks: [new LtiAgsGradeSink({ services, registrations: lti.registrations })],
    }),
    approvals,
    toolKeys: lti.toolKeys,
    requestIdentityLink: (link) => recordPendingIdentityLink(stores.identityLinks, link),
  });

  const handler = createLtiHandler({
    broker,
    dynamicRegistration,
    onResourceLinkLaunch: async (launch) => {
      await recordLaunchServices(lti.contextServices, launch);
      return htmlPage(await launchPage(launch));
    },
    onDeepLinkingRequest: async (launch, session) => {
      await recordLaunchServices(lti.contextServices, launch);
      return htmlPage(await pickerPage(launch, session));
    },
    selectActivities: policySelectActivities({ authorizer: app.engine, activities }),
  });

  /** Who the launch is, where, and what it opens, from the directory: nothing the platform claimed. */
  async function launchPage(launch: ResolvedLaunch): Promise<string> {
    const snapshot = await directory();
    const principal = snapshot.principals.find((p) => p.id === launch.principal.principalId);
    const offering = snapshot.offerings.find((o) => o.id === launch.offeringId);
    const course = snapshot.courses.find((c) => c.id === offering?.courseId);
    const activity = launch.activity === undefined ? undefined : await activities.find(launch.activity);
    return [
      `<h1>${escapeHtml(activity?.title ?? course?.title ?? "EducateOS")}</h1>`,
      `<p>Signed in to EducateOS as <strong>${escapeHtml(principal?.displayName ?? launch.principal.principalId)}</strong>`,
      ` (${escapeHtml(launch.principal.kind)}), in ${escapeHtml(course?.title ?? "a course")}${offering === undefined ? "" : `, ${escapeHtml(offering.sectionName)}`}.</p>`,
      activity === undefined ? "<p>This link does not open an EducateOS activity.</p>" : `<p>Activity <code>${escapeHtml(launch.activity!)}</code>.</p>`,
      `<p class="meta">Launch accepted: ${escapeHtml(launch.messageType)}; offering <code>${escapeHtml(launch.offeringId)}</code>;`,
      ` course services: ${launch.services?.ags === undefined ? "" : "gradebook (AGS) "}${launch.services?.nrps === undefined ? "" : "roster (NRPS)"}</p>`,
    ].join("");
  }

  /** The content picker: the activities assigned in the launch's offering, posted with the session. */
  async function pickerPage(launch: ResolvedLaunch, session: string): Promise<string> {
    const choices = await offeringActivities(stores, activities, districtId, launch.offeringId);
    const items = choices.map(({ activityId, title }) =>
      `<li><label><input type="checkbox" name="activity" value="${escapeHtml(activityId)}"> ${escapeHtml(title)}</label></li>`);
    return [
      "<h1>Add an EducateOS activity</h1>",
      `<form method="post" action="${escapeHtml(broker.endpoints.deepLink)}">`,
      `<input type="hidden" name="session" value="${escapeHtml(session)}">`,
      items.length === 0 ? "<p>This course has no assigned activities yet.</p>" : `<ul>${items.join("")}</ul>`,
      '<button type="submit">Add selected</button>',
      "</form>",
    ].join("");
  }

  type AdminRoute = (caller: Caller, request: Request, params: Record<string, string>) => Promise<unknown>;
  const adminRoutes: { method: "GET" | "POST"; path: string; run: AdminRoute }[] = [
    { method: "POST", path: "invitations", run: (caller) => admin.inviteRegistration(caller) },
    {
      method: "GET", path: "registrations", run: async (caller) => ({
        registrations: await admin.listRegistrations(caller),
        pending: await admin.listPendingRegistrations(caller),
      }),
    },
    { method: "POST", path: "pending/:id/approve", run: async (caller, request, { id }) => admin.approveRegistration(caller, id, await jsonBody(request)) },
    {
      method: "POST", path: "pending/:id/reject", run: async (caller, _request, { id }) => {
        await admin.rejectRegistration(caller, id);
        return { rejected: id };
      },
    },
    { method: "POST", path: "trusted-issuers", run: async (caller, request) => ({ trustedIssuers: await advantage.trustPlatformIssuer(caller, (await jsonObject(request)).issuer) }) },
    { method: "POST", path: "identity-links", run: async (caller, request) => ({ requestId: await advantage.requestIdentityLink(caller, await jsonBody(request)) }) },
    { method: "GET", path: "offerings/:offeringId/services", run: (caller, _request, { offeringId }) => admin.listContextServices(caller, offeringId) },
    { method: "POST", path: "grade-routes", run: async (caller, request) => admin.routeGradesToPlatform(caller, await jsonBody(request)) },
    {
      method: "POST", path: "grade-columns", run: async (caller, request) => {
        await admin.bindGradeColumn(caller, await jsonBody(request));
        return { bound: true };
      },
    },
    { method: "POST", path: "line-items", run: async (caller, request) => advantage.createLineItem(caller, await jsonBody(request)) },
    { method: "POST", path: "roster", run: async (caller, request) => advantage.readRoster(caller, await jsonBody(request)) },
    { method: "POST", path: "passback", run: async (caller, request) => advantage.publishGrade(caller, await jsonBody(request)) },
    { method: "GET", path: "tool-keys", run: async (caller) => ({ kids: await advantage.toolKeyIds(caller) }) },
    { method: "POST", path: "tool-keys/rotate", run: (caller) => advantage.rotateToolKeys(caller) },
  ];

  async function callerOf(request: Request): Promise<Caller> {
    const identity = await options.verifyRequest(request);
    if (identity === undefined) throw new EducateOsError("unauthenticated", "Sign in to manage this district's LTI connections.");
    const principal = await createDirectoryPrincipalResolver(await directory()).resolve(identity);
    return { principal: { principalId: principal.principalId, districtId: principal.districtId }, channel: "http" };
  }

  return {
    async serveTool(request) {
      if (!new URL(request.url).pathname.startsWith("/lti/")) return undefined;
      try {
        await loadKeys();
      } catch (error) {
        return errorResponse(error);
      }
      const response = await handler(request);
      return response ?? errorResponse(new EducateOsError("not-found", "No such LTI endpoint."));
    },

    async serveAdmin(request) {
      try {
        await loadKeys();
        const path = new URL(request.url).pathname.slice(LTI_API_PREFIX.length);
        const matched = matchAdminRoute(adminRoutes, request.method, path);
        if (matched === undefined) throw new EducateOsError("not-found", "No such LTI route.");
        // Every POST, bodiless ones too, must say it is JSON: a cross-site form cannot, so a page
        // elsewhere cannot use an administrator's Access session to rotate keys or reject a platform.
        if (request.method === "POST" && !isJson(request)) throw new EducateOsError("validation-failed", "Send the request as application/json.");
        const caller = await callerOf(request);
        return Response.json(await matched.route.run(caller, request, matched.params), { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

/** The activities assigned in `offeringId`, each once, with the titles the catalog gives them. */
async function offeringActivities(
  stores: DistrictAppStores,
  activities: ActivityCatalog,
  districtId: DistrictId,
  offeringId: string,
): Promise<{ activityId: ActivityId; title: string }[]> {
  const { state } = await stores.assessment.load();
  const ids = new Set(state.assignments.filter((a) => a.districtId === districtId && a.offeringId === offeringId).map((a) => a.activityId));
  const found = [];
  for (const activityId of ids) {
    const activity = await activities.find(activityId);
    if (activity?.scope.offeringId === offeringId) found.push({ activityId, title: activity.title });
  }
  return found;
}

function matchAdminRoute<R extends { method: string; path: string }>(routes: readonly R[], method: string, path: string): { route: R; params: Record<string, string> } | undefined {
  const segments = path.split("/");
  for (const route of routes) {
    const pattern = route.path.split("/");
    if (route.method !== method || pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (const [index, part] of pattern.entries()) {
      const actual = segments[index]!;
      if (part.startsWith(":") && actual !== "") params[part.slice(1)] = actual;
      else if (part !== actual) matched = false;
    }
    if (matched) return { route, params };
  }
  return undefined;
}

/** A JSON request body. The content type must be JSON, which a cross-site form cannot send without a preflight. */
async function jsonBody(request: Request): Promise<unknown> {
  if (!isJson(request)) throw new EducateOsError("validation-failed", "Send the request body as application/json.");
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new EducateOsError("validation-failed", "The request body is not JSON.");
  }
}

function isJson(request: Request): boolean {
  return /^application\/json(;|$)/i.test(request.headers.get("content-type") ?? "");
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = z.record(z.string(), z.unknown()).safeParse(await jsonBody(request));
  if (!body.success) throw new EducateOsError("validation-failed", "Expected a JSON object.");
  return body.data;
}

function errorResponse(error: unknown): Response {
  if (error instanceof EducateOsError) {
    return Response.json(error.toBody(), { status: ERROR_STATUS[error.code], headers: { "cache-control": "no-store" } });
  }
  throw error;
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";

function htmlPage(body: string): Response {
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>EducateOS</title>",
    "<style>body{font:16px/1.5 system-ui,sans-serif;margin:1.5rem;max-width:42rem;color:#1d2433}h1{font-size:1.4rem}.meta{color:#5b6475;font-size:.85rem}ul{list-style:none;padding:0}li{margin:.4rem 0}</style>",
    `</head><body><main>${body}</main></body></html>`,
  ].join("");
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP, "referrer-policy": "same-origin" },
  });
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
