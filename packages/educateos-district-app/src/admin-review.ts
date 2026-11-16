// What an IT reviewer reads in the admin console (SCHO-376): the decision trail as a safety
// decision log and an admin audit log, Hall Monitor's discussion screening, and how the district
// signs people in. The schemas are the routes' (routes.ts imports them); the builders shape what
// the stores hold into them. Everything here is identifiers, closed vocabulary and names from the
// directory: never content, and never a secret.
import { z } from "zod";
import {
  Action,
  ClassLinkSso,
  DecisionReason,
  DelegationId,
  OfferingId,
  PrincipalId,
  RequestChannel,
  ResourceKind,
  type DistrictDirectorySnapshot,
} from "@educateos/contracts";
import type { DiscussionBoard } from "@educateos/discussions";

/** A position in the decision trail, as a query parameter: a positive whole number. */
const TrailPosition = z.string().regex(/^[1-9][0-9]{0,15}$/, "expected a trail position").transform(Number);

/**
 * Which decisions the safety decision log shows: every one, the refusals, the ones held for an
 * approval, or the allowed ones.
 */
export const DecisionOutcome = z.enum(["all", "refused", "held", "allowed"]);
/** A decision outcome filter. */
export type DecisionOutcome = z.infer<typeof DecisionOutcome>;

/** The effects each {@link DecisionOutcome} finds, or undefined for every one. */
export const OUTCOME_EFFECTS: Readonly<Record<DecisionOutcome, readonly ("allow" | "deny" | "require-approval")[] | undefined>> = {
  all: undefined,
  refused: ["deny"],
  held: ["require-approval"],
  allowed: ["allow"],
};

/** The filters the safety decision log takes. */
export const DecisionLogQuery = z.strictObject({
  /** The previous page's `nextBefore`. */
  before: TrailPosition.optional(),
  /** Every decision when absent. */
  outcome: DecisionOutcome.optional(),
  /** A rule ID, or a prefix ending in `.` (such as `discussion.`). */
  rule: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(128).optional(),
  /** Whose requests. */
  principalId: PrincipalId.optional(),
  /** What kind of record they were for. */
  resourceKind: ResourceKind.optional(),
});

/** The filters the admin audit log takes. */
export const AdminAuditLogQuery = z.strictObject({
  /** The previous page's `nextBefore`. */
  before: TrailPosition.optional(),
  /** Whose changes. */
  principalId: PrincipalId.optional(),
  /** What kind of record they changed. */
  resourceKind: ResourceKind.optional(),
});

/** One decision, as the console lists it. */
export const DecisionEntryBody = z.strictObject({
  /** Its position in the trail. */
  seq: z.int().positive(),
  decidedAt: z.iso.datetime(),
  /** Links it to the request's error body and the other decisions the same request made. */
  correlationId: z.string(),
  principalId: PrincipalId.optional(),
  /** The subject's name in the directory, when the directory still has them. */
  principalName: z.string().optional(),
  action: Action.optional(),
  resourceKind: ResourceKind.optional(),
  resourceId: z.string().optional(),
  channel: RequestChannel.optional(),
  effect: z.enum(["allow", "deny", "require-approval"]),
  /** Why it was not simply allowed. */
  reason: DecisionReason.optional(),
  /** The rule that decided, or a `precheck.*` / `subject.*` / `scope.*` / `default.*` pseudo-rule. */
  ruleId: z.string(),
  /** The record the rule relied on, such as an appeal grant. */
  grantId: z.string().optional(),
  /** The delegation a client acted under. */
  delegationId: DelegationId.optional(),
});
/** A decision entry. */
export type DecisionEntryBody = z.infer<typeof DecisionEntryBody>;

/** One page of decisions, newest first. */
export const DecisionPageBody = z.strictObject({
  entries: z.array(DecisionEntryBody),
  /**
   * The next page's `before`, absent at the start of the trail. A page may be short, even empty,
   * and still have a next one: each search looks at a bounded stretch of the trail.
   */
  nextBefore: z.string().optional(),
});
/** A page of decisions. */
export type DecisionPageBody = z.infer<typeof DecisionPageBody>;

/** What Hall Monitor decided about a student's discussion post. */
export const ScreeningDecision = z.enum(["refused", "hold", "coach"]);

/** One Hall Monitor decision on a discussion post. Never the post's text. */
export const ScreeningEntryBody = z.strictObject({
  at: z.iso.datetime(),
  offeringId: OfferingId,
  /** The class, as its course and section. */
  offeringName: z.string(),
  /** `refused`: kept from being shared at all; `hold`: kept for a teacher; `coach`: shown, with a concern. */
  decision: ScreeningDecision,
  /** Hall Monitor's reason codes. Labels only. */
  reasonCodes: z.array(z.string()),
  authorId: PrincipalId.optional(),
  authorName: z.string().optional(),
  /** Where the post stands now, for one that was shared or held. */
  postStatus: z.enum(["visible", "pending", "hidden", "removed"]).optional(),
});
/** A screening entry. */
export type ScreeningEntryBody = z.infer<typeof ScreeningEntryBody>;

/** The most screening entries one answer lists. */
export const MAX_SCREENING_ENTRIES = 200;

/** Hall Monitor's discussion screening across the district's classes, newest first. */
export const ScreeningLogBody = z.strictObject({
  /**
   * How student posts are screened here: by Hall Monitor, held for a teacher with no screening, or
   * published unscreened (synthetic demos only).
   */
  screening: z.enum(["hall-monitor", "held-for-teachers", "published-unscreened"]),
  entries: z.array(ScreeningEntryBody),
  /** Whether there were more than {@link MAX_SCREENING_ENTRIES}. */
  truncated: z.boolean(),
});
/** A screening log. */
export type ScreeningLogBody = z.infer<typeof ScreeningLogBody>;

/**
 * How a deployment verifies sign-ins, as its host tells the district application. Identifiers
 * only: an Access application's audience tags and every credential stay with the host.
 */
export const SignInDeployment = z.discriminatedUnion("verifier", [
  z.strictObject({
    verifier: z.literal("cloudflare-access"),
    /** The Access team domain whose signed assertions are accepted. */
    teamDomain: z.url({ protocol: /^https$/ }),
    /** How many Access applications' assertions are accepted. */
    applications: z.int().positive(),
    /** The Clever district whose Instant Login is accepted behind Access, when there is one. */
    cleverDistrictId: z.string().min(1).max(64).optional(),
  }),
  /** Synthetic sign-ins, as the demo districts have. */
  z.strictObject({ verifier: z.literal("demo") }),
]);
/** A sign-in deployment. */
export type SignInDeployment = z.infer<typeof SignInDeployment>;

/** How the district signs people in, as it knows it. Never a secret. */
export const SignInSettingsBody = z.strictObject({
  /** The sign-in provider the head configuration revision names, absent before one is applied. */
  provider: z.enum(["district-sso", "cloudflare-access"]).optional(),
  /** ClassLink sign-in, when configured: its tenant, issuer and relying-party client ID. The client secret is a Worker secret. */
  classlink: ClassLinkSso.pick({ tenantId: true, issuer: true, clientId: true, subjectClaim: true }).optional(),
  /** Each issuer the district trusts, with how many people it signs in. */
  issuers: z.array(z.strictObject({
    issuer: z.string(),
    /** Active people with an identity from this issuer. */
    activePeople: z.int().nonnegative(),
    /** Inactive people with one. */
    inactivePeople: z.int().nonnegative(),
  })),
  /** Active people no trusted issuer can sign in. */
  activeWithoutSignIn: z.int().nonnegative(),
  /** Sign-ins waiting for an administrator to link them to a person. */
  pendingLinks: z.int().nonnegative(),
  /** How this deployment verifies sign-ins, when its host said. */
  deployment: SignInDeployment.optional(),
});
/** Sign-in settings. */
export type SignInSettingsBody = z.infer<typeof SignInSettingsBody>;

/** A stored decision as the console lists it, named from `snapshot`. */
export function decisionEntry(
  stored: { seq: number; event: Omit<DecisionEntryBody, "seq" | "principalName"> & { districtId?: string } },
  snapshot: DistrictDirectorySnapshot,
): DecisionEntryBody {
  // The district is this one: every event in its trail is its own or a refusal of another's.
  const { districtId: _district, ...event } = stored.event;
  const name = event.principalId === undefined ? undefined : snapshot.principals.find((p) => p.id === event.principalId)?.displayName;
  return { seq: stored.seq, ...event, ...(name === undefined ? {} : { principalName: name }) };
}

/** Each class's name, as its course and section. */
export function offeringNames(snapshot: DistrictDirectorySnapshot): Map<string, string> {
  const titles = new Map(snapshot.courses.map((c) => [c.id, c.title]));
  return new Map(snapshot.offerings.map((o) => [o.id, `${titles.get(o.courseId) ?? "Course"} · ${o.sectionName}`]));
}

/**
 * Hall Monitor's decisions in `boards`, newest first: the posts it refused (the moderation trail's
 * `screening-refused` entries) and the posts it held or let through with a concern (their open
 * screening flags). A flag a teacher dismissed is no longer on its post, so it is not listed.
 */
export function screeningEntries(boards: readonly DiscussionBoard[], snapshot: DistrictDirectorySnapshot): ScreeningEntryBody[] {
  const names = offeringNames(snapshot);
  const people = new Map(snapshot.principals.map((p) => [p.id, p.displayName]));
  const entries: ScreeningEntryBody[] = [];
  const author = (id: string | undefined) => {
    const name = id === undefined ? undefined : people.get(id as PrincipalId);
    return { ...(id === undefined ? {} : { authorId: id as PrincipalId }), ...(name === undefined ? {} : { authorName: name }) };
  };
  for (const board of boards) {
    const offeringName = names.get(board.offeringId) ?? board.offeringId;
    for (const event of board.moderation) {
      if (event.action !== "screening-refused") continue;
      entries.push({ at: event.at, offeringId: board.offeringId, offeringName, decision: "refused", reasonCodes: event.reasonCodes ?? [], ...author(event.authorId ?? event.by) });
    }
    for (const post of board.posts) {
      for (const flag of post.flags) {
        if (flag.kind !== "screening") continue;
        entries.push({ at: flag.at, offeringId: board.offeringId, offeringName, decision: flag.decision, reasonCodes: flag.reasonCodes, ...author(post.authorId), postStatus: post.status });
      }
    }
  }
  return entries.toSorted((a, b) => b.at.localeCompare(a.at));
}

/** How many people each trusted issuer signs in, and how many active people none does. */
export function signInCoverage(snapshot: DistrictDirectorySnapshot): Pick<SignInSettingsBody, "issuers" | "activeWithoutSignIn"> {
  const trusted = snapshot.district.trustedIssuers;
  const issuers = trusted.map((issuer) => {
    const holders = snapshot.principals.filter((p) => p.kind !== "service" && p.externalIdentities.some((i) => i.issuer === issuer));
    return {
      issuer,
      activePeople: holders.filter((p) => p.status === "active").length,
      inactivePeople: holders.filter((p) => p.status !== "active").length,
    };
  });
  const activeWithoutSignIn = snapshot.principals
    .filter((p) => p.kind !== "service" && p.status === "active" && !p.externalIdentities.some((i) => trusted.includes(i.issuer))).length;
  return { issuers, activeWithoutSignIn };
}
