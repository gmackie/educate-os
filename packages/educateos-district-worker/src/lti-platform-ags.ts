// The LTI Platform's Assignment and Grade Services 2.0 over HTTP (SCHO-179, IF-10), under
// `/lti/platform/ags/`, and the teacher's routes that decide the scores tools send. Served only as
// part of the platform, so only when `LTI_PLATFORM=on` (lti-platform.ts). Like lti.ts it imports
// nothing Workers-only (ADR-0009).
//
// A tool calls `/lti/platform/ags/<deployment>/<offering>/lineitems` from its own server with a
// service token from `/lti/platform/token`: GET lists and POST creates line items; GET, PUT and
// DELETE `…/lineitems/<id>` read, replace and remove one; POST `…/<id>/scores` sends a score, which
// waits for a teacher; GET `…/<id>/results` reads the approved results. A teacher lists the scores
// waiting for them at `/api/lti/platform-scores` and approves or declines each, behind Access.
import { ERROR_STATUS } from "@educateos/academics";
import { EducateOsError, type Authorizer, type DistrictDirectorySnapshot, type DistrictId } from "@educateos/contracts";
import { AGS_MEDIA_TYPES, type PlatformServiceGrant } from "@educateos/lti";
import { LtiPlatformAgsService, type LtiDistrictStores } from "@educateos/lti-district";
import type { PolicyDecider } from "@educateos/policy";
import { createLogger } from "@gadgets/observability/logger";
import type { LtiAdminRoute } from "./lti-platform.ts";

/** What the AGS endpoints log beside each event: never a token, a score, a grade or a body. */
interface AgsLogFields {
  districtId: string;
  toolId?: string;
  /** The refusal's error code. */
  code?: string;
  /** How many line items or results an answer listed. */
  count?: number;
}

const logger = createLogger<AgsLogFields>({ component: "educateos.lti.platform" });

/** The largest line item or score body read, in bytes. */
const MAX_BODY_BYTES = 16 * 1024;

/** What the platform's AGS endpoints are built from. */
export interface PlatformAgsOptions {
  readonly districtId: DistrictId;
  readonly policy: Authorizer & PolicyDecider;
  readonly stores: LtiDistrictStores;
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  /** Reads a request's JSON body, refusing anything but `application/json` (lti.ts's `jsonBody`). */
  readonly jsonBody: (request: Request) => Promise<unknown>;
  /** The URL the AGS endpoints are under: `<origin>/lti/platform/ags`. */
  readonly agsUrl: string;
  /** What a request's access token lets its tool do (`DistrictLtiPlatform.verifyServiceRequest`). */
  readonly verify: (request: Request) => Promise<PlatformServiceGrant | undefined>;
}

/** The platform's AGS endpoints and the teacher's score decisions. */
export interface PlatformAgs {
  readonly service: LtiPlatformAgsService;
  /** Serves `path`, relative to `/lti/platform/ags/`, or returns `undefined` for no such endpoint. */
  serve(request: Request, path: string): Promise<Response | undefined>;
  /** The teacher's signed-in routes, relative to `/api/lti/`. */
  readonly adminRoutes: readonly LtiAdminRoute[];
}

/** Starts the platform's AGS endpoints over the district's LTI stores. */
export function startPlatformAgs(options: PlatformAgsOptions): PlatformAgs {
  const { stores } = options;
  const log = logger.with({ districtId: options.districtId });
  const service = new LtiPlatformAgsService({
    districtId: options.districtId,
    policy: options.policy,
    directory: options.directory,
    tools: stores.platformTools,
    subjects: stores.platformSubjects,
    store: stores.platformAgs,
    approvals: stores.platformScoreApprovals,
    agsUrl: options.agsUrl,
  });

  async function answer(request: Request, grant: PlatformServiceGrant, segments: readonly string[]): Promise<Response | undefined> {
    const [deploymentId, offeringId, container, lineItemId, below] = segments as [string, string, string, string?, string?];
    if (container !== "lineitems" || segments.length > 5) return undefined;
    const toolId = grant.tool.id;
    const query = new URL(request.url).searchParams;
    if (lineItemId === undefined) {
      if (request.method === "GET") {
        const items = await service.listLineItems(grant, deploymentId, offeringId, {
          resourceLinkId: query.get("resource_link_id") ?? undefined,
          resourceId: query.get("resource_id") ?? undefined,
          tag: query.get("tag") ?? undefined,
        });
        log.info("listed AGS line items", { event: "lti.platform.ags.line-items.listed", toolId, count: items.length });
        return agsJson(items, AGS_MEDIA_TYPES.lineItemContainer);
      }
      if (request.method === "POST") {
        const item = await service.createLineItem(grant, deploymentId, offeringId, await agsBody(request, AGS_MEDIA_TYPES.lineItem));
        log.info("created an AGS line item", { event: "lti.platform.ags.line-item.created", toolId });
        return agsJson(item, AGS_MEDIA_TYPES.lineItem, 201);
      }
      return undefined;
    }
    if (below === undefined) {
      if (request.method === "GET") return agsJson(await service.lineItem(grant, deploymentId, offeringId, lineItemId), AGS_MEDIA_TYPES.lineItem);
      if (request.method === "PUT") {
        const item = await service.replaceLineItem(grant, deploymentId, offeringId, lineItemId, await agsBody(request, AGS_MEDIA_TYPES.lineItem));
        log.info("replaced an AGS line item", { event: "lti.platform.ags.line-item.replaced", toolId });
        return agsJson(item, AGS_MEDIA_TYPES.lineItem);
      }
      if (request.method === "DELETE") {
        await service.deleteLineItem(grant, deploymentId, offeringId, lineItemId);
        log.info("removed an AGS line item", { event: "lti.platform.ags.line-item.removed", toolId });
        return new Response(null, { status: 204, headers: NO_STORE });
      }
      return undefined;
    }
    if (below === "scores" && request.method === "POST") {
      const { queued } = await service.postScore(grant, deploymentId, offeringId, lineItemId, await agsBody(request, AGS_MEDIA_TYPES.score));
      if (queued) log.info("queued an AGS score for a teacher's approval", { event: "lti.platform.ags.score.queued", toolId });
      else log.info("recorded an AGS score's progress", { event: "lti.platform.ags.score.progress", toolId });
      return new Response(null, { status: 204, headers: NO_STORE });
    }
    if (below === "results" && request.method === "GET") {
      const results = await service.results(grant, deploymentId, offeringId, lineItemId, { userId: query.get("user_id") ?? undefined });
      log.info("read AGS results", { event: "lti.platform.ags.results.read", toolId, count: results.length });
      return agsJson(results, AGS_MEDIA_TYPES.resultContainer);
    }
    return undefined;
  }

  return {
    service,
    async serve(request, path) {
      const segments = path.split("/");
      if (segments.length < 3 || segments.some((segment) => segment === "")) return undefined;
      // The token is checked first, so nothing about a deployment or line item is told to a caller without one.
      const grant = await options.verify(request);
      if (grant === undefined) {
        log.info("refused an AGS call without a current access token", { event: "lti.platform.ags.unauthenticated" });
        return bearerError(401, "invalid_token", "The access token is missing, expired or revoked.");
      }
      try {
        return await answer(request, grant, segments);
      } catch (error) {
        if (!(error instanceof EducateOsError)) throw error;
        log.warn("refused an AGS call", { event: "lti.platform.ags.refused", toolId: grant.tool.id, code: error.code });
        if (error.code === "forbidden") return bearerError(403, "insufficient_scope", error.message);
        return Response.json(error.toBody(), { status: ERROR_STATUS[error.code], headers: NO_STORE });
      }
    },
    adminRoutes: [
      // A teacher's own queue: the policy engine decides, per score, who may approve it.
      { method: "GET", path: "platform-scores", run: async (caller) => ({ scores: await service.pendingScores(caller) }) },
      {
        method: "POST", path: "platform-scores/:id/approve", run: async (caller, request, { id }) => {
          const outcome = await service.approveScore(caller, id, await options.jsonBody(request));
          log.info("a teacher approved an AGS score", { event: "lti.platform.ags.score.approved" });
          return outcome;
        },
      },
      {
        method: "POST", path: "platform-scores/:id/decline", run: async (caller, request, { id }) => {
          const outcome = await service.declineScore(caller, id, await options.jsonBody(request));
          log.info("a teacher declined an AGS score", { event: "lti.platform.ags.score.declined" });
          return outcome;
        },
      },
    ],
  };
}

const NO_STORE = { "cache-control": "no-store" } as const;

function agsJson(body: unknown, mediaType: string, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, "content-type": mediaType } });
}

/** A bearer token refusal (RFC 6750 §3). */
function bearerError(status: 401 | 403, error: "invalid_token" | "insufficient_scope", description: string): Response {
  return Response.json({ error, error_description: description }, {
    status,
    headers: { ...NO_STORE, "www-authenticate": `Bearer error="${error}"` },
  });
}

/**
 * A line item or score body: JSON no larger than 16 KiB, sent as `mediaType` or as
 * `application/json`.
 */
async function agsBody(request: Request, mediaType: string): Promise<unknown> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== mediaType && type !== "application/json") throw new EducateOsError("validation-failed", `Send the body as ${mediaType}.`);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new EducateOsError("validation-failed", "The body is too large.");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new EducateOsError("validation-failed", "The body is too large.");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new EducateOsError("validation-failed", "The body is not JSON.");
  }
}
