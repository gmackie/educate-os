// EducateOS as an LTI 1.3 Platform (SCHO-179, IF-10): the district hosting third-party tools. It is
// served beside the district's LTI Tool (lti.ts), under `/lti/platform/`, and only when the
// deployment turns it on (`LTI_PLATFORM=on`); off, every platform path is 404 and its
// administrators' routes do not exist. Like lti.ts it imports nothing Workers-only (ADR-0009).
//
// So far it publishes the platform's signing keys: `GET /lti/platform/jwks` is public (tools fetch
// it from their own servers, so it is under the Access-exempt `/lti/` paths), and the key IDs and
// rotation are administrators' routes behind Access, decided by the policy engine.
import { EducateOsError, type Caller, type DistrictId, type Authorizer } from "@educateos/contracts";
import { LtiPlatformKeyService, type LtiDistrictStores } from "@educateos/lti-district";

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

/** Starts the district's LTI Platform over its LTI stores. */
export function startDistrictLtiPlatform(options: { districtId: DistrictId; authorizer: Authorizer; stores: LtiDistrictStores }): DistrictLtiPlatform {
  const keys = new LtiPlatformKeyService({ districtId: options.districtId, authorizer: options.authorizer, keys: options.stores.platformKeys });
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
    ],
  };
}

/** The refusal for a platform path on a district that runs no platform. */
export const NO_PLATFORM = (): EducateOsError => new EducateOsError("not-found", "This district runs no LTI Platform.");
