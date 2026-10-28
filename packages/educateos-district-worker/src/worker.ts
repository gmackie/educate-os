// The EducateOS district Worker (SCHO-171): the district application (`@educateos/district-app`)
// deployed over Durable Object storage. It serves the district's `/api` surface, and two service
// entrypoints for the Workers that take a `EDUCATEOS_DISTRICT` binding:
//
// - `DistrictGuardDirectory`, the AI call guard's read model (`GuardDirectoryPort` in
//   `@educateos/ai-guard`, SCHO-132/SCHO-147). Given to the guard alone, never on `/api`.
// - `DistrictSchoolTools`, the EducateOS gatekeeper's `SchoolToolService` (SCHO-57).
//
// `DistrictPrincipalResolver`, the Workshop backend's `PRINCIPAL_RESOLVER` (SCHO-259), which says
// who a sign-in the backend has already verified is;
//
// and `DistrictApi`, the `/api` surface as a service, which is what the release binds to the
// backend (`EDUCATEOS_DISTRICT_API`). It carries no authority of its own: every request must bring
// an Access assertion the district verifies itself.
//
// Every call reaches the district's one `DistrictObject` through `ctx.exports`, named by the
// district ID in `DISTRICT_CONFIG`. README.md explains the design and the deployment. Like
// district-object.ts, this module is checked by running it (ADR-0009, see tsconfig.json).
import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type { DistrictDirectorySnapshot, VerifiedPrincipal } from "@educateos/contracts";
import type { AdmittedSubjectRequest, GuardDirectory, GuardSubject, GuardSubjectRequest } from "@educateos/district-app/guard-directory";
import type { SchoolToolService } from "@educateos/gatekeeper";
import type { SchoolToolListing, SchoolToolOutcome, ToolDecisionOutcome } from "@educateos/policy";
import { configuredDistrictId } from "./district.ts";
import { SCHOOL_MANIFEST_PATH, serveSchoolManifest } from "./school-manifest.ts";

export { DistrictObject } from "./district-object.ts";

/** The district's object. */
function districtObject(env: Cloudflare.Env, exports: Cloudflare.Exports) {
  return exports.DistrictObject.getByName(configuredDistrictId(env.DISTRICT_CONFIG));
}

/** The `EDUCATEOS_DISTRICT` entrypoint for the AI call guard: the district's guard read model. */
@validateRpc()
export class DistrictGuardDirectory extends WorkerEntrypoint<Cloudflare.Env> implements GuardDirectory {
  /** What the district says about a Workshop user, or `null`. */
  async guardSubject(request: GuardSubjectRequest): Promise<GuardSubject | null> {
    return districtObject(this.env, this.ctx.exports).guardSubject(request);
  }

  /** What the district says now about an admitted call's principal, or `null`. */
  async admittedSubject(request: AdmittedSubjectRequest): Promise<GuardSubject | null> {
    return districtObject(this.env, this.ctx.exports).admittedSubject(request);
  }

  /** The profile-free directory the guard's ledger resolves funding against. */
  async ledgerDirectory(): Promise<DistrictDirectorySnapshot> {
    return districtObject(this.env, this.ctx.exports).ledgerDirectory();
  }
}

/** The `EDUCATEOS_DISTRICT` entrypoint for the EducateOS gatekeeper: the district's school tools. */
@validateRpc()
export class DistrictSchoolTools extends WorkerEntrypoint<Cloudflare.Env> implements SchoolToolService {
  /**
   * The principal a browser request is signed in as, by the district's Access sign-in, or `null`.
   * Not validated: a Request is not a type capnweb-validate describes, and the district verifies
   * it from scratch.
   */
  @skipRpcValidation()
  async authenticate(request: Request): Promise<VerifiedPrincipal | null> {
    return districtObject(this.env, this.ctx.exports).authenticate(request);
  }

  /** The district's school tools. */
  async listTools(): Promise<SchoolToolListing[]> {
    return districtObject(this.env, this.ctx.exports).listTools();
  }

  /** Runs one tool call for `subject` as an agent's: reads answer at once, writes are queued. */
  async callTool(subject: VerifiedPrincipal, name: string, args: unknown): Promise<SchoolToolOutcome> {
    return districtObject(this.env, this.ctx.exports).callTool(subject, name, args);
  }

  /** Approves a queued change as `approver`'s own decision. */
  async approveChange(approver: VerifiedPrincipal, approvalId: string): Promise<ToolDecisionOutcome> {
    return districtObject(this.env, this.ctx.exports).approveChange(approver, approvalId);
  }

  /** Declines a queued change as `decider`'s own decision, with a reason the requester sees. */
  async declineChange(decider: VerifiedPrincipal, approvalId: string, reason: string): Promise<ToolDecisionOutcome> {
    return districtObject(this.env, this.ctx.exports).declineChange(decider, approvalId, reason);
  }

  /**
   * Serves one `/api` request as `principal`'s own, for the EducateOS connector's school pages
   * (SCHO-218). Not validated, for the same reason as `authenticate`; the district application
   * parses the principal itself and refuses anyone who is not an active principal of this district.
   */
  @skipRpcValidation()
  async serveAs(principal: VerifiedPrincipal, request: Request): Promise<Response> {
    return districtObject(this.env, this.ctx.exports).serveAs(principal, request);
  }
}

/** A verified Access sign-in, as the Workshop's principal resolver seam passes it. */
interface WorkshopAccessSignIn {
  issuer: string;
  subject: string;
  email?: string;
}

/** One existing email-keyed Workshop user. */
interface WorkshopEmailKeyedUser {
  email: string;
  workshopUserId: string;
}

/** What the seam answers, in plain types (the district's own carry brands). */
type WorkshopPrincipalResolution =
  | { outcome: "resolved"; principalId: string; displayName: string }
  | { outcome: "unauthenticated" }
  | { outcome: "adoption-pending" };

/** What the district says about one email-keyed Workshop user. */
type WorkshopEmailKeyedUserMatch =
  | { email: string; outcome: "exact-single"; principalId: string }
  | { email: string; outcome: "ambiguous" | "cross-district" | "unmatched" };

/**
 * The Workshop backend's `PRINCIPAL_RESOLVER` and `PRINCIPAL_MIGRATION` (SCHO-259, ADR-0014): the
 * kernel's `PrincipalResolver` and `PrincipalMigrationDirectory` (`@gadgets/workshop-shared/
 * principal-resolver`, matched by hand: ADR-0002). It trusts its caller to have verified the
 * Access token, so it is bound to the Workshop backend alone; unlike `DistrictApi`, holding it
 * says who people are. Nothing binds it until a deployment's cutover.
 */
@validateRpc()
export class DistrictPrincipalResolver extends WorkerEntrypoint<Cloudflare.Env> {
  /** The principal a verified Access sign-in is linked to, or `unauthenticated`. */
  async resolveAccessSignIn(signIn: WorkshopAccessSignIn): Promise<WorkshopPrincipalResolution> {
    return districtObject(this.env, this.ctx.exports).resolveAccessSignIn(signIn);
  }

  /** Matches existing email-keyed Workshop users to the district's people. Links nothing. */
  async matchEmailKeyedUsers(users: WorkshopEmailKeyedUser[]): Promise<WorkshopEmailKeyedUserMatch[]> {
    return districtObject(this.env, this.ctx.exports).matchEmailKeyedUsers(users);
  }
}

/**
 * The `/api` surface as a service binding target: the release's backend binding
 * (`EDUCATEOS_DISTRICT_API`, see `SERVICE_PACKAGES` in scripts/release/manifest-lib.ts). Nothing in
 * the instance routes to it yet. Like the public fetch handler it serves only `/api/`, and every
 * request is verified by the district from scratch, so holding the binding grants nothing.
 */
export class DistrictApi extends WorkerEntrypoint<Cloudflare.Env> {
  /** Serves the district's `/api` surface. */
  override async fetch(request: Request): Promise<Response> {
    return serveApi(request, this.env, this.ctx.exports);
  }
}

function serveApi(request: Request, env: Cloudflare.Env, exports: Cloudflare.Exports): Promise<Response> | Response {
  if (!new URL(request.url).pathname.startsWith("/api/")) return new Response(null, { status: 404 });
  return districtObject(env, exports).fetch(request);
}

export default {
  /**
   * The district's `/api` surface; `/healthz`, a liveness probe that reads nothing and needs no
   * sign-in (a deployment exempts it from Access); and the LTI Tool's `/lti/*` endpoints (SCHO-177),
   * which platform users reach from their LMS, so a deployment exempts exactly those paths from
   * Access too. Nothing else is served; a deployment that serves the district's UIs does so as
   * static assets in front of this handler.
   */
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
    // The public school manifest (ADR-0014): no sign-in, so a deployment exempts it from Access too.
    if (pathname === SCHOOL_MANIFEST_PATH) {
      return serveSchoolManifest(request, { districtConfig: env.DISTRICT_CONFIG, settings: env.SCHOOL_MANIFEST, versionTag: env.CF_VERSION_METADATA?.tag });
    }
    if (pathname.startsWith("/lti/")) return districtObject(env, ctx.exports).fetch(request);
    return serveApi(request, env, ctx.exports);
  },
  /** The district's Cron Triggers (SCHO-189): notifications hourly, the family digest weekly. See schedule.ts. */
  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(districtObject(env, ctx.exports).runScheduled(controller.cron));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
