// The SchoolOS district Worker (SCHO-171): the district application (`@schoolos/district-app`)
// deployed over Durable Object storage. It serves the district's `/api` surface, and two service
// entrypoints for the Workers that take a `SCHOOLOS_DISTRICT` binding:
//
// - `DistrictGuardDirectory`, the AI call guard's read model (`GuardDirectoryPort` in
//   `@schoolos/ai-guard`, SCHO-132/SCHO-147). Given to the guard alone, never on `/api`.
// - `DistrictSchoolTools`, the SchoolOS gatekeeper's `SchoolToolService` (SCHO-57).
//
// and `DistrictApi`, the `/api` surface as a service, which is what the release binds to the
// backend (`SCHOOLOS_DISTRICT_API`). It carries no authority of its own: every request must bring
// an Access assertion the district verifies itself.
//
// Every call reaches the district's one `DistrictObject` through `ctx.exports`, named by the
// district ID in `DISTRICT_CONFIG`. README.md explains the design and the deployment. Like
// district-object.ts, this module is checked by running it (ADR-0009, see tsconfig.json).
import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type { DistrictDirectorySnapshot, VerifiedPrincipal } from "@schoolos/contracts";
import type { AdmittedSubjectRequest, GuardDirectory, GuardSubject, GuardSubjectRequest } from "@schoolos/district-app/guard-directory";
import type { SchoolToolService } from "@schoolos/gatekeeper";
import type { SchoolToolListing, SchoolToolOutcome, ToolDecisionOutcome } from "@schoolos/policy";
import { configuredDistrictId } from "./district.ts";

export { DistrictObject } from "./district-object.ts";

/** The district's object. */
function districtObject(env: Cloudflare.Env, exports: Cloudflare.Exports) {
  return exports.DistrictObject.getByName(configuredDistrictId(env.DISTRICT_CONFIG));
}

/** The `SCHOOLOS_DISTRICT` entrypoint for the AI call guard: the district's guard read model. */
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

/** The `SCHOOLOS_DISTRICT` entrypoint for the SchoolOS gatekeeper: the district's school tools. */
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
}

/**
 * The `/api` surface as a service binding target: the release's backend binding
 * (`SCHOOLOS_DISTRICT_API`, see `SERVICE_PACKAGES` in scripts/release/manifest-lib.ts). Nothing in
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
  /** The district's `/api` surface. Nothing else is served. */
  async fetch(request, env, ctx): Promise<Response> {
    return serveApi(request, env, ctx.exports);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
