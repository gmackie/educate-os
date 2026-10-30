// The district side of the gatekeeper: what the gatekeeper asks of the district's own services, and
// that service composed in process over a `SchoolToolRunner`. A district deployment exposes the same
// object from its own Worker and injects it as the gatekeeper's `EDUCATEOS_DISTRICT` service binding.
import type { DistrictResponse } from "./school-app-api.ts";
import type { DistrictId, VerifiedPrincipal } from "@educateos/contracts";
import type { SchoolToolListing, SchoolToolOutcome, SchoolToolRunner, ToolDecisionOutcome } from "@educateos/policy";

/**
 * The district's school tools, as the gatekeeper reaches them. Only the gatekeeper holds this
 * binding, and it passes only subjects it read from a connected account, never from tool input.
 *
 * - Tool calls arrive on the `agent` channel with every write queued for a person (see
 *   `SchoolToolRunner.invoke`'s `confirmWrites`), so nothing an agent sends changes a record
 *   before a person decides it.
 * - Decisions arrive on the `http` channel, because the gatekeeper forwards one only for a
 *   person's approval or rejection in the Workshop, never on an agent's behalf.
 * - School pages arrive on the `http` channel too, through {@link SchoolToolService.serveAs}: the
 *   account's own person using the district's screens from their Workshop session (SCHO-218). No
 *   session an agent or gadget holds reaches it (see README.md, "School pages").
 */
export interface SchoolToolService {
  /**
   * The principal a browser request is signed in as, by the district's own sign-in (its Access
   * token or session), or `null` when it is not signed in to this district.
   */
  authenticate(request: Request): Promise<VerifiedPrincipal | null>;
  /** The district's school tools. */
  listTools(): Promise<SchoolToolListing[]>;
  /** Runs one tool call for `subject` as an agent's: reads answer at once, writes are queued. */
  callTool(subject: VerifiedPrincipal, name: string, args: unknown): Promise<SchoolToolOutcome>;
  /** Approves a queued change as `approver`'s own decision. */
  approveChange(approver: VerifiedPrincipal, approvalId: string): Promise<ToolDecisionOutcome>;
  /** Declines a queued change as `decider`'s own decision, with a reason the requester sees. */
  declineChange(decider: VerifiedPrincipal, approvalId: string, reason: string): Promise<ToolDecisionOutcome>;
  /**
   * Serves one request to the district's `/api` surface as `principal`'s own, whatever credential
   * the request carries: the routes, surfaces and policy of the district's own sign-in, on the
   * `http` channel. A principal of another district, one the directory does not know, or one no
   * longer active is `unauthenticated`; the onboarding route is refused.
   */
  serveAs(principal: VerifiedPrincipal, request: Request): Promise<Response>;
  /** Reads a configured assignment as the verified student; absent implementations fail closed. */
  gadgetAssessmentRead?(principal: VerifiedPrincipal, assignmentId: string): Promise<DistrictResponse>;
  /** Submits owned pinned revisions after the Workshop user approves the action. */
  gadgetAssessmentSubmit?(principal: VerifiedPrincipal, assignmentId: string, request: unknown): Promise<DistrictResponse>;

}

/** What {@link createSchoolToolService} composes. */
export interface SchoolToolServiceOptions {
  /** The district the service answers for. A subject from any other district is refused. */
  districtId: DistrictId;
  /** The district's tool runner. It must have an approval queue. */
  runner: SchoolToolRunner;
  /** Verifies a browser request with the district's own sign-in. */
  authenticate(request: Request): Promise<VerifiedPrincipal | null>;
  /** The district application's `/api` surface for an already-verified principal (`DistrictApp.serveAs`). */
  serveAs(principal: VerifiedPrincipal, request: Request): Promise<Response>;
  /** Reads a configured assignment as the verified student; absent implementations fail closed. */
  gadgetAssessmentRead?(principal: VerifiedPrincipal, assignmentId: string): Promise<DistrictResponse>;
  /** Submits owned pinned revisions after the Workshop user approves the action. */
  gadgetAssessmentSubmit?(principal: VerifiedPrincipal, assignmentId: string, request: unknown): Promise<DistrictResponse>;

}

/**
 * The district's {@link SchoolToolService} over its tool runner: what a district Worker exposes to
 * the gatekeeper, and what tests compose in process. A subject from another district is refused
 * before anything runs, as is any principal `authenticate` reports from another district. A page
 * served for one is refused the same way, with the `401` the district's own surface answers.
 */
export function createSchoolToolService(options: SchoolToolServiceOptions): SchoolToolService {
  const { districtId, runner } = options;
  const outsider = (subject: VerifiedPrincipal) => subject.districtId !== districtId;
  const refused = { status: "error", error: { code: "unauthenticated", message: "This account belongs to another district." } } as const;
  return {
    async gadgetAssessmentRead(principal, assignmentId) {
      if (outsider(principal) || !options.gadgetAssessmentRead) return { status: 403, body: '{"message":"Assessment capability unavailable."}', correlationId: null };
      return options.gadgetAssessmentRead(principal, assignmentId);
    },
    async gadgetAssessmentSubmit(principal, assignmentId, request) {
      if (outsider(principal) || !options.gadgetAssessmentSubmit) return { status: 403, body: '{"message":"Assessment capability unavailable."}', correlationId: null };
      return options.gadgetAssessmentSubmit(principal, assignmentId, request);
    },
    async authenticate(request) {
      const principal = await options.authenticate(request);
      return principal === null || outsider(principal) ? null : principal;
    },
    async listTools() {
      return runner.list();
    },
    async callTool(subject, name, args) {
      if (outsider(subject)) return refused;
      return runner.invoke({ principal: subject, channel: "agent" }, name, args, { confirmWrites: true });
    },
    async approveChange(approver, approvalId) {
      if (outsider(approver)) return refused;
      return runner.approve({ principal: approver, channel: "http" }, approvalId);
    },
    async declineChange(decider, approvalId, reason) {
      if (outsider(decider)) return refused;
      return runner.decline({ principal: decider, channel: "http" }, approvalId, reason);
    },
    async serveAs(principal, request) {
      if (outsider(principal)) return Response.json(refused.error, { status: 401, headers: { "cache-control": "no-store" } });
      return options.serveAs(principal, request);
    },
  };
}
