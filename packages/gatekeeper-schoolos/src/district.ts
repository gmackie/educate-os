// The district side of the gatekeeper: what the gatekeeper asks of the district's own services, and
// that service composed in process over a `SchoolToolRunner`. A district deployment exposes the same
// object from its own Worker and injects it as the gatekeeper's `SCHOOLOS_DISTRICT` service binding.
import type { DistrictId, VerifiedPrincipal } from "@schoolos/contracts";
import type { SchoolToolListing, SchoolToolOutcome, SchoolToolRunner, ToolDecisionOutcome } from "@schoolos/policy";

/**
 * The district's school tools, as the gatekeeper reaches them. Only the gatekeeper holds this
 * binding, and it passes only subjects it read from a connected account, never from tool input.
 *
 * - Tool calls arrive on the `agent` channel with every write queued for a person (see
 *   `SchoolToolRunner.invoke`'s `confirmWrites`), so nothing an agent sends changes a record
 *   before a person decides it.
 * - Decisions arrive on the `http` channel, because the gatekeeper forwards one only for a
 *   person's approval or rejection in the Workshop, never on an agent's behalf.
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
}

/** What {@link createSchoolToolService} composes. */
export interface SchoolToolServiceOptions {
  /** The district the service answers for. A subject from any other district is refused. */
  districtId: DistrictId;
  /** The district's tool runner. It must have an approval queue. */
  runner: SchoolToolRunner;
  /** Verifies a browser request with the district's own sign-in. */
  authenticate(request: Request): Promise<VerifiedPrincipal | null>;
}

/**
 * The district's {@link SchoolToolService} over its tool runner: what a district Worker exposes to
 * the gatekeeper, and what tests compose in process. A subject from another district is refused
 * before anything runs, as is any principal `authenticate` reports from another district.
 */
export function createSchoolToolService(options: SchoolToolServiceOptions): SchoolToolService {
  const { districtId, runner } = options;
  const outsider = (subject: VerifiedPrincipal) => subject.districtId !== districtId;
  const refused = { status: "error", error: { code: "unauthenticated", message: "This account belongs to another district." } } as const;
  return {
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
  };
}
