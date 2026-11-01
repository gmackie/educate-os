// EducateOS as an LTI 1.3 Platform (SCHO-179, IF-10): the district hosting third-party tools. It is
// served beside the district's LTI Tool (lti.ts), under `/lti/platform/`, and only when the
// deployment turns it on (`LTI_PLATFORM=on`); off, every platform path is 404 and its
// administrators' routes do not exist. Like lti.ts it imports nothing Workers-only (ADR-0009).
//
// So far it publishes the platform's signing keys: `GET /lti/platform/jwks` is public (tools fetch
// it from their own servers, so it is under the Access-exempt `/lti/` paths). Its administrators'
// routes, behind Access and decided by the policy engine, rotate those keys and register, deploy
// and revoke third-party tools.
import { EducateOsError, type Caller, type DistrictDirectorySnapshot, type DistrictId, type Authorizer } from "@educateos/contracts";
import { LtiPlatformKeyService, LtiPlatformToolService, type LtiDistrictStores } from "@educateos/lti-district";

/** The path prefix of the platform's public endpoints. */
export const LTI_PLATFORM_PREFIX = "/lti/platform/";

/**
 * Whether `LTI_PLATFORM` turns the platform on. Only the exact value `on` does: unset, empty or
 * anything else leaves it off, which is what every production configuration does until a live
 * enablement.
 */
export function ltiPlatformEnabled(setting: string | undefined): boolean {
  return setting === "on";
}

/** One administrators' route, as lti.ts serves them under `/api/lti/`. */
export interface LtiAdminRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly run: (caller: Caller, request: Request, params: Record<string, string>) => Promise<unknown>;
}

/** The district's LTI Platform: its public endpoints and its administrators' routes. */
export interface DistrictLtiPlatform {
  /** Serves a path under {@link LTI_PLATFORM_PREFIX}, or returns `undefined` for no such endpoint. */
  serve(request: Request): Promise<Response | undefined>;
  /** The administrators' routes, relative to `/api/lti/`. */
  readonly adminRoutes: readonly LtiAdminRoute[];
}

/** What the district's LTI Platform is built from. */
export interface DistrictLtiPlatformOptions {
  readonly districtId: DistrictId;
  readonly authorizer: Authorizer;
  readonly stores: LtiDistrictStores;
  /** The district directory, which a deployment's offerings are checked against. */
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  /** Reads a request's JSON body, refusing anything but `application/json` (lti.ts's `jsonBody`). */
  readonly jsonBody: (request: Request) => Promise<unknown>;
}

/** Starts the district's LTI Platform over its LTI stores. */
export function startDistrictLtiPlatform(options: DistrictLtiPlatformOptions): DistrictLtiPlatform {
  const { districtId, authorizer, jsonBody } = options;
  const keys = new LtiPlatformKeyService({ districtId, authorizer, keys: options.stores.platformKeys });
  const tools = new LtiPlatformToolService({ districtId, authorizer, directory: options.directory, store: options.stores.platformTools });
  return {
    async serve(request) {
      const path = new URL(request.url).pathname.slice(LTI_PLATFORM_PREFIX.length);
      if (path === "jwks" && request.method === "GET") {
        // Short-lived: a rotation keeps the previous key published, so a tool that cached the set a
        // few minutes ago still verifies, and one that sees an unknown key ID refetches.
        return Response.json(await keys.jwks(), { headers: { "cache-control": "public, max-age=300" } });
      }
      return undefined;
    },
    adminRoutes: [
      { method: "GET", path: "platform-keys", run: async (caller) => ({ kids: await keys.keyIds(caller) }) },
      { method: "POST", path: "platform-keys/rotate", run: (caller) => keys.rotate(caller) },
      { method: "GET", path: "platform-tools", run: (caller) => tools.list(caller) },
      { method: "POST", path: "platform-tools", run: async (caller, request) => tools.registerTool(caller, await jsonBody(request)) },
      { method: "POST", path: "platform-tools/:id/revoke", run: (caller, _request, { id }) => tools.revokeTool(caller, id) },
      { method: "POST", path: "platform-deployments", run: async (caller, request) => tools.deploy(caller, await jsonBody(request)) },
      { method: "POST", path: "platform-deployments/:id", run: async (caller, request, { id }) => tools.changeDeployment(caller, id, await jsonBody(request)) },
      { method: "POST", path: "platform-deployments/:id/revoke", run: (caller, _request, { id }) => tools.revokeDeployment(caller, id) },
    ],
  };
}

/** The refusal for a platform path on a district that runs no platform. */
export const NO_PLATFORM = (): EducateOsError => new EducateOsError("not-found", "This district runs no LTI Platform.");
