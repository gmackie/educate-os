// Screening student posts with Hall Monitor (SCHO-190, ADR-0007). A student's post is evaluated
// before anyone else can read it, through the same Hall Monitor client and policy profiles the AI
// call guard uses: the post is `interaction.input` from a student, read by a student audience.
//
// Privacy: the post's text goes to Hall Monitor and nowhere else; what is kept of a screening is
// its decision and machine reason codes.
import type { Decision, EvaluationRequest, EvaluationResult, GradeBand } from "@gmacko/hall-monitor-contracts";
import { z } from "zod";

// Hall Monitor's contract values, copied rather than imported: the vendored contracts package ships
// TypeScript sources, which Node refuses to strip under node_modules, so a value import would stop
// the district app (and the harness CLI) from running outside a bundler. `screening.test.ts` keeps
// the copies equal to the vendored package.

/** Hall Monitor's evaluation request schema version. */
export const SCHEMA_VERSION = "1.0" satisfies EvaluationRequest["schemaVersion"];

/** The longest text Hall Monitor evaluates in one request. */
export const MAX_TEXT_LENGTH = 32_000;

/** Hall Monitor's opaque identifier: a restricted alphabet that keeps content out of ID fields. */
export const OpaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/**
 * How a district screens student posts: its Hall Monitor client, reached the way the AI call guard
 * reaches it, and the pinned policy profile revision posts are evaluated under. A district that
 * configures none publishes student posts unscreened.
 */
export interface DiscussionScreening {
  /**
   * The district's Hall Monitor: `HallMonitorClient.evaluate` from `@gmacko/hall-monitor-client`,
   * of which only the decision and reason codes are read. (The client's own type is not named
   * here: its sources use syntax the SchoolOS libraries' erasable-only builds refuse.)
   */
  hallMonitor: { evaluate(request: EvaluationRequest): Promise<Pick<EvaluationResult, "decision" | "reasonCodes">> };
  /** The settings it is called with. */
  settings: DiscussionScreeningSettings;
}

/** The labels a screening request carries: who is asking, under which profile, billed where. */
export const DiscussionScreeningSettings = z.strictObject({
  /** The district's Hall Monitor tenant. */
  tenantId: OpaqueId,
  /** The pinned policy profile student posts are evaluated under. */
  profileId: OpaqueId,
  /** Its pinned revision. */
  revision: OpaqueId,
  /** The cost center Hall Monitor bills the evaluation to. */
  costCenterId: OpaqueId,
});
/** Discussion screening settings. */
export type DiscussionScreeningSettings = z.infer<typeof DiscussionScreeningSettings>;

/** What screening decided about a post. */
export type ScreeningVerdict =
  /** Publish it (or queue it, under pre-moderation). */
  | { outcome: "allow" }
  /** Publish it, flagged for the teachers: Hall Monitor would coach. */
  | { outcome: "flag"; decision: "coach"; reasonCodes: string[] }
  /** Keep it back for a teacher's approval, flagged: Hall Monitor would hold it. */
  | { outcome: "hold"; decision: "hold"; reasonCodes: string[] }
  /** Refuse it; the author sees `message`. Nothing of the post is kept. */
  | { outcome: "refuse"; decision: Extract<Decision, "block" | "support"> | "unavailable"; reasonCodes: string[]; message: string };

/** What a student is told when their post is refused. Plain, never naming a reason code. */
export const SCREENING_MESSAGES = {
  block: "Your post wasn't shared because it may not follow your class's discussion guidelines. Change it and try again, or ask your teacher.",
  support: "Your post wasn't shared. If something is worrying you, please talk to your teacher or another adult you trust.",
  unavailable: "Posting isn't available right now. Try again in a little while.",
} as const;

/** The Hall Monitor grade band of a course grade band such as `K`, `7` or `9-12`: the youngest grade in it. */
export function hallMonitorGradeBand(gradeBand: string | undefined): GradeBand {
  const lowest = gradeBand === undefined ? 0 : gradeBand.split("-")[0] === "K" ? 0 : Number.parseInt(gradeBand, 10);
  if (!Number.isFinite(lowest) || lowest <= 2) return "K-2";
  if (lowest <= 5) return "3-5";
  if (lowest <= 8) return "6-8";
  return "9-12";
}

/** One post to screen: its text, and labels that never identify the student. */
export interface ScreeningRequest {
  /** Unique per post and edit, so a retried evaluation replays rather than re-bills. */
  checkId: string;
  text: string;
  /** The course's grade band; unknown is evaluated as the youngest. */
  gradeBand?: string;
}

/**
 * Has Hall Monitor evaluate a post, in chunks it accepts, stopping at the first that may not be
 * shared. A failure to reach Hall Monitor refuses the post: a student audience always fails closed
 * (ADR-0007 §6).
 */
export async function screenPost(screening: DiscussionScreening, request: ScreeningRequest): Promise<ScreeningVerdict> {
  const { hallMonitor, settings } = screening;
  const gradeBand = hallMonitorGradeBand(request.gradeBand);
  let flagged: Extract<ScreeningVerdict, { outcome: "flag" | "hold" }> | undefined;
  for (const [index, text] of chunks(request.text).entries()) {
    const checkId = `${request.checkId}.c${index}`;
    const evaluation: EvaluationRequest = {
      schemaVersion: SCHEMA_VERSION,
      requestId: checkId,
      idempotencyKey: checkId,
      source: { product: "schoolos", tenantId: settings.tenantId, surface: "discussion.post" },
      policy: { profileId: settings.profileId, revision: settings.revision },
      context: { audience: "student", gradeBand, costCenterId: settings.costCenterId },
      evaluationKind: "interaction.input",
      content: { type: "text", text },
    };
    let decision: Decision;
    let reasonCodes: string[];
    try {
      ({ decision, reasonCodes } = await hallMonitor.evaluate(evaluation));
    } catch {
      return { outcome: "refuse", decision: "unavailable", reasonCodes: [], message: SCREENING_MESSAGES.unavailable };
    }
    if (decision === "block" || decision === "support") return { outcome: "refuse", decision, reasonCodes, message: SCREENING_MESSAGES[decision] };
    if (decision === "hold") flagged = { outcome: "hold", decision, reasonCodes };
    else if (decision === "coach" && flagged === undefined) flagged = { outcome: "flag", decision, reasonCodes };
  }
  return flagged ?? { outcome: "allow" };
}

/** The text in pieces Hall Monitor accepts, never splitting a surrogate pair. */
function chunks(text: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_TEXT_LENGTH, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    if (text.slice(start, end).trim().length > 0) pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}
