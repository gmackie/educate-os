// Guidance and Evidence: teacher standards priorities and coverage, guardian and teacher
// learning invitations, and optional social-emotional practice (CASEL). Browser-safe: this module
// carries the schemas the routes and UIs share, the pure coverage calculation and the store contract,
// and nothing that reads a request. `guidance-routes.ts` is the only place that applies policy.
//
// Invariants the types themselves encode, so no handler can quietly break them:
//   - every invitation is `kind: "suggestion"`, `isAssignment: false`, `required: false`;
//   - coverage keeps *opportunities* (offered, accepted, shared) and *mastery* (students per
//     evidence state) in separate counter objects, and never derives one from the other;
//   - nothing here has a score, a sentiment, a trait or a diagnosis field.
import { z } from "zod";
import { EducateOsError, OfferingId, PrincipalId } from "@educateos/contracts";
import type { GuardianGuidanceGrantStore } from "@educateos/policy";
import { PlannerAssistance, PlannerLevel, PlannerSkill, plannerTeacherView, type PlannerPlan } from "./planner.ts";

// Standards

/**
 * Where a standard stands against the district's approved releases. `unmapped` is explicit: the
 * saved standard is not in any approved release, so nothing is inferred about it.
 */
export const StandardState = z.enum(["approved", "hidden", "not-approved", "unmapped"]);
/** A standard's state. */
export type StandardState = z.infer<typeof StandardState>;

/**
 * The standards this build can collect shared evidence for today: the planner's two fixed
 * mappings. Every other approved standard can be prioritised and tracked, and shows `none`, so a
 * teacher sees plainly that no evidence pathway exists yet instead of an empty-looking success.
 * A test keeps this in step with `plannerOpportunities`.
 */
export const PLANNER_EVIDENCE_CODES: ReadonlySet<string> = new Set(["6.RP.A.3", "W.6.1"]);

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const Plain = (max: number) => z.string().trim().min(1).max(max).refine((text) => !/(https?:\/\/|www\.|@\S+\.\S+|\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b)/i.test(text), "Use plain words: no links, email addresses or phone numbers.");

// Teacher priorities

/** One standard a teacher has chosen to emphasise, with optional pacing and an optional discussion prompt. */
export const GuidancePriorityInput = z.strictObject({
  frameworkKey: z.string().min(1).max(100),
  competencyUri: z.string().min(1).max(500),
  level: z.enum(["focus", "supporting"]),
  pacing: z.strictObject({ startsOn: IsoDay, endsOn: IsoDay }).refine((p) => p.startsOn <= p.endsOn, "pacing must end on or after it starts").optional(),
  /** An optional prompt for class discussion. Shown to students as an invitation, never as work to submit. */
  discussionPrompt: Plain(500).optional(),
});
/** A priority a teacher is saving. */
export type GuidancePriorityInput = z.infer<typeof GuidancePriorityInput>;
/** A saved priority: the input plus the standard's code and text as they were when it was saved. */
export const GuidancePriority = GuidancePriorityInput.extend({ code: z.string(), statement: z.string() });
/** A saved priority. */
export type GuidancePriority = z.infer<typeof GuidancePriority>;

// Stored records. One table holds all of them; `scope` is an offering ID, or `student:<id>`.

const Stamp = z.strictObject({ by: PrincipalId, byName: z.string(), at: z.iso.datetime() });
/** A class's standards agenda: at most one per offering. */
export const GuidanceAgenda = z.strictObject({
  type: z.literal("agenda"), id: z.string(), scope: z.string(), revision: z.number().int().positive(), offeringId: OfferingId,
  priorities: z.array(GuidancePriority).max(30), updated: Stamp,
});
/** A class's standards agenda. */
export type GuidanceAgenda = z.infer<typeof GuidanceAgenda>;
/** A student's response to an invitation. Declining is private to the student. */
const Response = z.strictObject({ decision: z.enum(["accepted", "declined"]), at: z.iso.datetime() });
/**
 * A guardian's suggestion for one child in one class. It reaches the child only after a teacher
 * shares it, always shows who it came from, and is never an assignment.
 */
export const GuidanceSuggestion = z.strictObject({
  type: z.literal("suggestion"), id: z.string().uuid(), scope: z.string(), revision: z.number().int().positive(),
  offeringId: OfferingId, studentId: PrincipalId, guardianId: PrincipalId, guardianName: z.string(), relationshipId: z.string(),
  kind: z.enum(["curiosity", "hobby"]), topic: Plain(120), note: Plain(400).optional(),
  status: z.enum(["awaiting-teacher", "shared", "declined", "withdrawn"]),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  review: Stamp.extend({ decision: z.enum(["share", "decline"]), note: Plain(300).optional() }).optional(),
  student: Response.optional(),
});
/** A guardian suggestion. */
export type GuidanceSuggestion = z.infer<typeof GuidanceSuggestion>;
/** A teacher's optional social-emotional practice invitation. It has no score, prompt text of its own or free-text reply. */
export const GuidancePractice = z.strictObject({
  type: z.literal("practice"), id: z.string().uuid(), scope: z.string(), revision: z.number().int().positive(),
  offeringId: OfferingId, studentId: PrincipalId, authorId: PrincipalId, authorName: z.string(),
  skill: PlannerSkill, note: Plain(300).optional(), createdAt: z.iso.datetime(), student: Response.optional(),
});
/** A practice invitation. */
export type GuidancePractice = z.infer<typeof GuidancePractice>;
/** A student's switch for family suggestions. Off by the student's own choice, never inferred. */
export const GuidancePreference = z.strictObject({
  type: z.literal("preference"), id: z.string(), scope: z.string(), revision: z.number().int().positive(),
  studentId: PrincipalId, guardianSuggestions: z.enum(["on", "off"]), updatedAt: z.iso.datetime(),
});
/** A student's preference record. */
export type GuidancePreference = z.infer<typeof GuidancePreference>;
/** Any record the guidance store keeps. */
export const GuidanceRecord = z.discriminatedUnion("type", [GuidanceAgenda, GuidanceSuggestion, GuidancePractice, GuidancePreference]);
/** A guidance record. */
export type GuidanceRecord = z.infer<typeof GuidanceRecord>;

/** Per-district persistence with optimistic concurrency, shared by the in-memory and Durable Object adapters. */
export interface GuidanceStore {
  /** Every record in `scope`, oldest first. */
  list(scope: string): Promise<GuidanceRecord[]>;
  /** Stores `record` if the stored revision is `expectedRevision` (0: none). Otherwise `conflict`. */
  save(record: GuidanceRecord, expectedRevision: number): Promise<void>;
}
/** A stale tab must reload rather than overwrite a teacher's or student's decision. */
export const guidanceConflict = () => new EducateOsError("conflict", "This changed. Reload it before trying again.");
/** Development and test adapter; the deployed Worker uses the Durable Object one. */
export class InMemoryGuidanceStore implements GuidanceStore {
  readonly #records = new Map<string, GuidanceRecord>();
  async list(scope: string): Promise<GuidanceRecord[]> {
    return structuredClone([...this.#records.values()].filter((r) => r.scope === scope));
  }
  async save(raw: GuidanceRecord, expectedRevision: number): Promise<void> {
    const record = GuidanceRecord.parse(raw);
    if ((this.#records.get(record.id)?.revision ?? 0) !== expectedRevision || record.revision !== expectedRevision + 1) throw guidanceConflict();
    this.#records.set(record.id, structuredClone(record));
  }
}

// Fixed, non-clinical practice catalog (CASEL)

/**
 * The only practice invitations that exist. The wording is fixed here, not written per student,
 * so no invitation can ask about feelings, home life or behaviour. `area` names the broad CASEL
 * competency area for a teacher's orientation; it is not a standard alignment, an assessment or a
 * claim about any student.
 */
export const PRACTICE_CATALOG = {
  teamwork: { title: "Team practice", area: "Relationship skills", prompt: "Next time you work with others, try one thing: ask a teammate what they think before the group decides." },
  planning: { title: "Planning practice", area: "Self-management", prompt: "Before you start your next project, write your first three steps and when you could do each one." },
  communication: { title: "Communication practice", area: "Relationship skills", prompt: "Explain one idea from this class to someone in your own words, then ask if it made sense." },
} as const satisfies Record<z.infer<typeof PlannerSkill>, { title: string; area: string; prompt: string }>;

/** What each adult can and cannot see, shown to students and families as written. */
export const GUIDANCE_TRANSPARENCY = [
  "Everything here is a suggestion. None of it is an assignment, has a due date or changes a grade.",
  "Each suggestion shows who it came from. Family suggestions reach you only after your teacher chooses to share one.",
  "You can accept or decline any suggestion. If you decline, nobody is told. Your teacher is told only if you accept.",
  "You can switch family suggestions off at any time.",
  "Your teacher sees work you choose to share. Private goals, chats and personal spaces are never shown to families or teachers here.",
  "Families see only a short progress label for standards your teacher chose, for their own child. They never see your responses, your chats or other students.",
  "Practice invitations are about teamwork, planning and communication. They are not tests, have no score, and are never used to describe you.",
] as const;

// Coverage

/** How far a student's shared evidence for one standard goes. Independent-reviewed is never inferred. */
export const MasteryState = z.enum(["needs-evidence", "encountered", "practiced", "independent-reviewed"]);
/** A mastery state. */
export type MasteryState = z.infer<typeof MasteryState>;
const RANK: Record<MasteryState, number> = { "needs-evidence": 0, "encountered": 1, "practiced": 2, "independent-reviewed": 3 };

type Opportunity = PlannerPlan["opportunities"][number];

/**
 * One opportunity's evidence state. Offering, accepting or skipping gives none. Shared work with no
 * teacher review is only `encountered`. `independent-reviewed` needs the teacher's latest review to
 * be a recommendation made on independently assessed, unassisted work, and the learner's own
 * disclosure to say independent as well. A later hold supersedes an earlier recommendation.
 */
export function opportunityState(opportunity: Opportunity): MasteryState {
  if (opportunity.response === undefined) return "needs-evidence";
  const review = opportunity.reviews.at(-1);
  if (review === undefined) return "encountered";
  if (review.decision === "recommend" && review.independentlyAssessed && review.assistance === "independent" && opportunity.response.assistance === "independent") return "independent-reviewed";
  return review.level === "encountered" ? "encountered" : "practiced";
}

/** What the resolver says about one standard. */
export interface ResolvedStandard {
  state: StandardState;
  code: string;
  statement: string;
  frameworkTitle?: string;
  publisher?: string;
  releaseVersion?: string;
  provenance?: "official" | "derived" | "district-authored";
}

/** Opportunity counters: what was offered and chosen. These say nothing about mastery. */
export const OpportunityCounts = z.strictObject({ offered: z.number().int(), accepted: z.number().int(), skipped: z.number().int(), shared: z.number().int(), reviewed: z.number().int() });
/** Mastery counters: students per evidence state. They always add up to the roster. */
export const MasteryCounts = z.strictObject({ "needs-evidence": z.number().int(), "encountered": z.number().int(), "practiced": z.number().int(), "independent-reviewed": z.number().int() });
/** One standard's coverage in one class. */
export const CoverageRow = z.strictObject({
  frameworkKey: z.string(), competencyUri: z.string(), code: z.string(), statement: z.string(),
  state: StandardState,
  frameworkTitle: z.string().optional(), publisher: z.string().optional(), releaseVersion: z.string().optional(),
  provenance: z.enum(["official", "derived", "district-authored"]).optional(),
  priority: z.strictObject({ level: z.enum(["focus", "supporting"]), pacing: GuidancePriorityInput.shape.pacing, discussionPrompt: z.string().optional() }).optional(),
  /** `planner` when students can share evidence for it today; `none` when no pathway exists yet. */
  evidencePathway: z.enum(["planner", "none"]),
  roster: z.number().int(),
  mastery: MasteryCounts,
  opportunities: OpportunityCounts,
});
/** One standard's coverage. */
export type CoverageRow = z.infer<typeof CoverageRow>;

/** The class members coverage is counted over. */
export interface RosterStudent { id: string; displayName: string }

const keyOf = (frameworkKey: string, competencyUri: string) => `${frameworkKey}\u0000${competencyUri}`;

/** The state of every roster student for every standard with a priority or shared evidence. */
export interface CoverageComputation {
  rows: CoverageRow[];
  /** Per row key, per student: the state and the opportunities the teacher may see. */
  students: Map<string, Map<string, { state: MasteryState; opportunities: Opportunity[] }>>;
}

/**
 * Standards coverage for one class. It is computed from the plans exactly as a teacher is allowed
 * to see them (`plannerTeacherView`), so a learner's private goal, skills and unshared opportunities
 * can never enter a count. Students who are not on the roster are ignored.
 */
export async function computeCoverage(input: {
  roster: readonly RosterStudent[];
  plans: readonly PlannerPlan[];
  priorities: readonly GuidancePriority[];
  /** `known` is the code and text the priority or the shared evidence carried, for a standard that is no longer resolvable. */
  resolve: (frameworkKey: string, competencyUri: string, known: { code: string; statement: string }) => Promise<ResolvedStandard>;
}): Promise<CoverageComputation> {
  const rosterIds = new Set(input.roster.map((s) => s.id));
  const visible = input.plans.filter((p) => rosterIds.has(p.studentId)).flatMap((p) => {
    const view = plannerTeacherView(p);
    return view === undefined ? [] : [{ plan: p, opportunities: view.opportunities }];
  });
  const keys = new Map<string, { frameworkKey: string; competencyUri: string; known: { code: string; statement: string }; saved?: GuidancePriority }>();
  for (const priority of input.priorities) keys.set(keyOf(priority.frameworkKey, priority.competencyUri), { frameworkKey: priority.frameworkKey, competencyUri: priority.competencyUri, known: { code: priority.code, statement: priority.statement }, saved: priority });
  for (const { opportunities } of visible) {
    for (const o of opportunities) {
      if (!keys.has(keyOf(o.frameworkKey, o.node.uri))) keys.set(keyOf(o.frameworkKey, o.node.uri), { frameworkKey: o.frameworkKey, competencyUri: o.node.uri, known: { code: o.node.humanCodingScheme ?? o.code, statement: o.node.fullStatement } });
    }
  }
  const rows: CoverageRow[] = [];
  const students: CoverageComputation["students"] = new Map();
  for (const [key, ref] of keys) {
    const standard = await input.resolve(ref.frameworkKey, ref.competencyUri, ref.known);
    const perStudent = new Map<string, { state: MasteryState; opportunities: Opportunity[] }>();
    const mastery = { "needs-evidence": 0, "encountered": 0, "practiced": 0, "independent-reviewed": 0 };
    const counts = { offered: 0, accepted: 0, skipped: 0, shared: 0, reviewed: 0 };
    for (const student of input.roster) {
      const opportunities = visible.filter((v) => v.plan.studentId === student.id).flatMap((v) => v.opportunities).filter((o) => o.frameworkKey === ref.frameworkKey && o.node.uri === ref.competencyUri);
      const state = opportunities.reduce<MasteryState>((best, o) => RANK[opportunityState(o)] > RANK[best] ? opportunityState(o) : best, "needs-evidence");
      perStudent.set(student.id, { state, opportunities });
      mastery[state]++;
      for (const o of opportunities) {
        counts.offered++;
        if (o.decision === "accepted") counts.accepted++;
        if (o.decision === "skipped") counts.skipped++;
        if (o.response !== undefined) counts.shared++;
        if (o.reviews.length > 0) counts.reviewed++;
      }
    }
    students.set(key, perStudent);
    const priority = ref.saved === undefined ? undefined : { level: ref.saved.level, ...(ref.saved.pacing === undefined ? {} : { pacing: ref.saved.pacing }), ...(ref.saved.discussionPrompt === undefined ? {} : { discussionPrompt: ref.saved.discussionPrompt }) };
    rows.push({
      frameworkKey: ref.frameworkKey, competencyUri: ref.competencyUri, code: standard.code, statement: standard.statement, state: standard.state,
      ...(standard.frameworkTitle === undefined ? {} : { frameworkTitle: standard.frameworkTitle }),
      ...(standard.publisher === undefined ? {} : { publisher: standard.publisher }),
      ...(standard.releaseVersion === undefined ? {} : { releaseVersion: standard.releaseVersion }),
      ...(standard.provenance === undefined ? {} : { provenance: standard.provenance }),
      ...(priority === undefined ? {} : { priority }),
      evidencePathway: PLANNER_EVIDENCE_CODES.has(standard.code) ? "planner" : "none",
      roster: input.roster.length, mastery, opportunities: counts,
    });
  }
  // Priorities first (focus before supporting), then standards that only have shared evidence.
  const order = (r: CoverageRow) => r.priority === undefined ? 2 : r.priority.level === "focus" ? 0 : 1;
  rows.sort((a, b) => order(a) - order(b) || a.code.localeCompare(b.code));
  return { rows, students };
}

/** Which of an invitation's lifecycle a suggestion is in, for a given moment. */
export function suggestionExpired(suggestion: Pick<GuidanceSuggestion, "expiresAt">, at: Date): boolean {
  return Date.parse(suggestion.expiresAt) <= at.getTime();
}
/** How long an unshared suggestion waits for a teacher, and how long a shared one stays visible. */
export const SUGGESTION_WAIT_DAYS = 30;
/** How long a shared suggestion stays visible to the student, in days from creation. */
export const SUGGESTION_VISIBLE_DAYS = 90;
/** The most open suggestions one guardian may have for one child in one class. */
export const MAX_OPEN_SUGGESTIONS = 3;

// Views and route bodies

const Origin = z.strictObject({ kind: z.enum(["teacher", "guardian"]), name: z.string() });
/** One invitation as the student sees it. */
export const StudentInvitation = z.strictObject({
  id: z.string(),
  /** Always a suggestion, never an assignment. These literals are the contract. */
  kind: z.literal("suggestion"), isAssignment: z.literal(false), required: z.literal(false),
  type: z.enum(["family-topic", "practice", "planner-invitation"]),
  origin: Origin,
  title: z.string(), detail: z.string().optional(),
  /** For practice invitations: the broad area, never an alignment or a score. */
  area: z.string().optional(),
  decision: z.enum(["pending", "accepted", "declined"]),
  revision: z.number().int().positive().optional(),
  /** A planner plan to open, for a teacher's standards invitation. */
  plannerPlanId: z.string().uuid().optional(),
  createdAt: z.iso.datetime(),
});
/** One invitation as a student sees it. */
export type StudentInvitation = z.infer<typeof StudentInvitation>;
/** What a student sees on their guidance page. */
export const StudentGuidanceBody = z.strictObject({
  invitations: z.array(StudentInvitation),
  preferences: z.strictObject({ guardianSuggestions: z.enum(["on", "off"]), revision: z.number().int().nonnegative() }),
  transparency: z.array(z.string()),
});
/** A teacher's view of one guardian suggestion. The student's decline is never shown. */
export const TeacherSuggestionView = z.strictObject({
  id: z.string().uuid(), revision: z.number().int().positive(), studentId: PrincipalId, studentName: z.string(), guardianName: z.string(),
  kind: GuidanceSuggestion.shape.kind, topic: z.string(), note: z.string().optional(),
  status: GuidanceSuggestion.shape.status, createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  review: GuidanceSuggestion.shape.review, studentAccepted: z.boolean(),
});
/** A teacher's view of a practice invitation: only whether the student opted in. */
export const TeacherPracticeView = z.strictObject({
  id: z.string().uuid(), studentId: PrincipalId, studentName: z.string(), skill: PlannerSkill, note: z.string().optional(), accepted: z.boolean(), createdAt: z.iso.datetime(),
});
/** The teacher guidance dashboard. */
export const TeacherGuidanceBody = z.strictObject({
  agenda: z.strictObject({ revision: z.number().int().nonnegative(), priorities: z.array(GuidancePriority) }),
  coverage: z.array(CoverageRow),
  suggestions: z.array(TeacherSuggestionView),
  practice: z.array(TeacherPracticeView),
  /** A reminder, from the same place the student UI reads it: this is guidance, not assignment. */
  assignmentNote: z.string(),
});
/** One student's evidence on one standard, as shared. Never a private goal, chat or unshared draft. */
export const EvidenceStudent = z.strictObject({
  studentId: PrincipalId, displayName: z.string(), state: MasteryState,
  evidence: z.array(z.strictObject({
    opportunityId: z.string().uuid(), planId: z.string().uuid(), source: z.enum(["student", "teacher"]), task: z.string(), criteria: z.array(z.string()), decision: z.enum(["offered", "accepted", "skipped"]),
    response: z.strictObject({ text: z.string(), assistance: PlannerAssistance, sharedAt: z.iso.datetime() }).optional(),
    reviews: z.array(z.strictObject({ level: PlannerLevel, assistance: PlannerAssistance, independentlyAssessed: z.boolean(), decision: z.enum(["hold", "recommend"]), rationale: z.string(), by: PrincipalId, at: z.iso.datetime() })),
  })),
});
/** Drill-down for one standard. */
export const TeacherEvidenceBody = z.strictObject({ row: CoverageRow, students: z.array(EvidenceStudent) });

/** The label a guardian is shown for a state: coarse, plain and never a grade. */
export const GUARDIAN_PROGRESS_LABEL: Record<MasteryState, string> = {
  "needs-evidence": "No shared work yet",
  "encountered": "Has started on this",
  "practiced": "Practising this",
  "independent-reviewed": "Showed this independently, reviewed by the teacher",
};
/** What a guardian may read about their own child, per class. */
export const GuardianGuidanceBody = z.strictObject({
  child: z.strictObject({ principalId: PrincipalId, displayName: z.string() }),
  /** Which of the two explicit grants an administrator turned on for this relationship. */
  capabilities: z.strictObject({ suggest: z.boolean(), progress: z.boolean() }),
  offerings: z.array(z.strictObject({
    offeringId: OfferingId, title: z.string(),
    progress: z.array(z.strictObject({ code: z.string(), statement: z.string(), focus: z.boolean(), label: z.string() })).optional(),
    suggestions: z.array(z.strictObject({ id: z.string().uuid(), revision: z.number().int().positive(), kind: GuidanceSuggestion.shape.kind, topic: z.string(), note: z.string().optional(), status: GuidanceSuggestion.shape.status, createdAt: z.iso.datetime() })).optional(),
  })),
  notice: z.string(),
});
/** A guardian's new suggestion. */
export const GuardianSuggestionInput = z.strictObject({ kind: GuidanceSuggestion.shape.kind, topic: GuidanceSuggestion.shape.topic, note: GuidanceSuggestion.shape.note });
/** An administrator's explicit opt-in state for a child's guardians. */
export const AdminGuardianGuidanceBody = z.strictObject({
  student: z.strictObject({ principalId: PrincipalId, displayName: z.string() }),
  relationships: z.array(z.strictObject({
    relationshipId: z.string(), guardianDisplayName: z.string(), status: z.enum(["pending", "active", "revoked"]), inForce: z.boolean(),
    enabled: z.boolean(), capabilities: z.array(z.enum(["suggest", "progress"])), revision: z.number().int().nonnegative(),
    history: z.array(z.strictObject({ action: z.enum(["enabled", "changed", "revoked"]), by: PrincipalId, at: z.iso.datetime(), capabilities: z.array(z.enum(["suggest", "progress"])) })),
  })),
});

/** The two stores this feature adds to a district's stores, kept together so the wiring is one field. */
export interface GuidanceStores {
  /** Standards agendas, guardian suggestions, practice invitations and student preferences. */
  records: GuidanceStore;
  /** Administrator opt-ins that let one guardian relationship reach learning guidance. Empty means off. */
  guardianGrants: GuardianGuidanceGrantStore;
}
