// The LTI Platform's Names and Role Provisioning Service (NRPS 2.0, SCHO-179), served under
// `/lti/platform/nrps/<deploymentId>/<offeringId>/memberships` beside the platform's other public
// endpoints (lti-platform.ts), and so only when `LTI_PLATFORM=on`. A tool calls it from its own
// server with a service token from `/lti/platform/token`; who may read which roster is decided by
// `LtiPlatformNrpsService` and the policy engine. Like lti.ts it imports nothing Workers-only.
import type { Authorizer, DistrictDirectorySnapshot, DistrictId, OfferingId } from "@educateos/contracts";
import {
  parsePlatformMembershipsPath,
  platformMembershipResponse,
  platformMembershipsPath,
  platformServiceRefusal,
  LTI_SCOPES,
  type PlatformDeploymentId,
  type PlatformServiceGrant,
} from "@educateos/lti";
import { LtiPlatformNrpsService, PlatformServiceRefused, type LtiDistrictStores } from "@educateos/lti-district";
import { createLogger } from "@gadgets/observability/logger";

/** What the platform logs beside each roster read: never a token, a subject or a member. */
interface NrpsLogFields {
  districtId: string;
  toolId?: string;
  deploymentId?: string;
  refusal?: string;
  members?: number;
}

const logger = createLogger<NrpsLogFields>({ component: "educateos.lti.platform" });

/** What the membership service is built from: the platform's own options and token verifier. */
export interface PlatformNrpsOptions {
  readonly districtId: DistrictId;
  readonly authorizer: Authorizer;
  readonly stores: LtiDistrictStores;
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  /** The platform's public prefix on the district's origin, such as `https://district.example/lti/platform/`. */
  readonly baseUrl: string;
  readonly verifyServiceRequest: (request: Request) => Promise<PlatformServiceGrant | undefined>;
}

/** The membership service: the URL launches advertise, and the endpoint that answers it. */
export interface PlatformNrps {
  /** The membership URL of a deployment and offering. */
  readonly membershipsUrl: (deploymentId: PlatformDeploymentId, offeringId: OfferingId) => string;
  /** Answers a path under the platform's prefix if it is a membership URL, or returns `undefined`. */
  serve(request: Request, path: string): Promise<Response | undefined>;
}

/** Starts the platform's membership service. */
export function startPlatformNrps(options: PlatformNrpsOptions): PlatformNrps {
  const log = logger.with({ districtId: options.districtId });
  const membershipsUrl = (deploymentId: PlatformDeploymentId, offeringId: OfferingId) => `${options.baseUrl}${platformMembershipsPath(deploymentId, offeringId)}`;
  const service = new LtiPlatformNrpsService({
    districtId: options.districtId,
    authorizer: options.authorizer,
    directory: options.directory,
    tools: options.stores.platformTools,
    subjects: options.stores.platformSubjects,
    membershipsUrl,
  });

  return {
    membershipsUrl,
    async serve(request, path) {
      const target = parsePlatformMembershipsPath(path);
      if (target === undefined || request.method !== "GET") return undefined;
      const grant = await options.verifyServiceRequest(request);
      if (grant === undefined) {
        log.info("refused a roster read", { event: "lti.platform.nrps.refused", refusal: "invalid_token" });
        return platformServiceRefusal("invalid_token");
      }
      const fields = { toolId: grant.tool.id, deploymentId: target.deploymentId };
      try {
        const params = new URL(request.url).searchParams;
        const page = await service.memberships(grant, target, { role: params.get("role"), limit: params.get("limit"), page: params.get("page") });
        log.info("a tool read a roster", { event: "lti.platform.nrps.read", ...fields, members: page.container.members.length });
        return platformMembershipResponse(page.container, page.next);
      } catch (error) {
        if (!(error instanceof PlatformServiceRefused)) throw error;
        log.warn("refused a roster read", { event: "lti.platform.nrps.refused", ...fields, refusal: error.code });
        return platformServiceRefusal(error.code, error.code === "insufficient_scope" ? LTI_SCOPES.contextMembershipReadonly : undefined);
      }
    },
  };
}
