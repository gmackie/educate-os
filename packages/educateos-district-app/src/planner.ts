import type { StudentLearningLifecycle } from "./student-learning-lifecycle.ts";
import { z } from "zod";
import { PlannerActivityEvidence } from "./planner-activity-evidence.ts";
import { EducateOsError, EvidenceContractId, OfferingId, PrincipalId } from "@educateos/contracts";
import { CompetencyNode, EvidenceContract, FrameworkDefinition } from "@educateos/registry";
import type { CatalogMirror } from "@educateos/catalog";
import { plannerKnowledge } from "./planner-evidence.ts";
import { PlannerChallenge, PlannerCoaching, plannerLesson } from "./planner-coaching.ts";
import { lessonFromRecipe, matchRecipeInterest, RecipeProvenance } from "./learning-recipe.ts";
import type { ResolvedRecipe } from "./learning-recipe-approval.ts";

/** Learning observations are distinct from mastery and from how much help was used. */
export const PlannerLevel = z.enum(["encountered", "practiced", "demonstrated", "retained", "transferred"]);
/** Optional skill practice only; these are not assessments or CASEL standards alignments. */
export const PlannerSkill = z.enum(["teamwork", "planning", "communication"]);
/** Unknown assistance never qualifies as independent evidence. */
export const PlannerAssistance = z.enum(["independent", "adult", "peer", "ai", "unknown"]);
/** A teacher's explicit, revisable observation; a recommendation never changes a grade. */
export const PlannerReviewInput = z.strictObject({
  level: PlannerLevel,
  assistance: PlannerAssistance,
  independentlyAssessed: z.boolean(),
  decision: z.enum(["hold", "recommend"]),
  rationale: z.string().trim().min(1).max(2000),
  assessment: z.strictObject({
    method: z.enum(["independent-task", "delayed-check", "new-context"]),
    observedAt: z.iso.datetime(),
    context: z.string().trim().min(1).max(500),
  }).optional(),
});
const Review = PlannerReviewInput.extend({ by: PrincipalId, at: z.iso.datetime() });
/** An opportunity pins the approved catalog metadata and evidence contract used at creation. */
export const PlannerOpportunity = z.strictObject({
  id: z.string().uuid(),
  /** The standard label shown to learners. A teacher-approved recipe may name any approved catalog item. */
  code: z.string().min(1).max(30),
  frameworkKey: z.string(),
  releaseVersion: z.string(),
  releaseDigest: z.string(),
  framework: FrameworkDefinition,
  node: CompetencyNode,
  reason: z.string(),
  task: z.string(),
  contract: EvidenceContract,
  priorEvidence: z.string(),
  decision: z.enum(["offered", "accepted", "skipped"]),
  response: z.strictObject({ text: z.string().trim().min(1).max(10000), assistance: PlannerAssistance, activityEvidence: PlannerActivityEvidence.optional(), sharedAt: z.iso.datetime() }).optional(),
  reviews: z.array(Review),
  coaching: PlannerCoaching.optional(),
  challenge: PlannerChallenge.optional(),
  /** Present when a teacher-approved recipe, not the fixed mapping, produced this opportunity. */
  recipe: RecipeProvenance.optional(),
  /** Derived on student reads only: archived work remains readable, but cannot be continued. */
  unavailableReason: z.string().optional(),
}).refine(
  // Both stores parse on every save and read, so no raw label can be credited to a standard it does not name:
  // the label is the pinned item's own code, or that code with one lettered component (6.RP.A.3 -> 6.RP.A.3b).
  (o) => o.node.humanCodingScheme !== undefined && (o.code === o.node.humanCodingScheme || (o.code.length === o.node.humanCodingScheme.length + 1 && o.code.startsWith(o.node.humanCodingScheme) && /[a-z]$/.test(o.code))),
  "The opportunity's standard label must be the pinned catalog item's own code.",
);
/** A private learner goal or a clearly attributed teacher invitation, never a required assignment. */
export const PlannerPlan = z.strictObject({
  id: z.string().uuid(), revision: z.number().int().positive(), offeringId: OfferingId, studentId: PrincipalId,
  goal: z.string().trim().min(1).max(1000), source: z.enum(["student", "teacher"]),
  authorId: PrincipalId, authorName: z.string(), createdAt: z.iso.datetime(),
  skills: z.array(PlannerSkill).max(3), opportunities: z.array(PlannerOpportunity).max(2),
});
/** A persisted planner record. */
export type PlannerPlan = z.infer<typeof PlannerPlan>;
/** The teacher view deliberately has no private learner goal or unshared learner opportunities. */
export const PlannerTeacherView = PlannerPlan.omit({ goal: true }).extend({ invitation: z.string().optional() });
/** A goal or teacher invitation to connect to standards. */
export const PlannerGoalInput = z.strictObject({
  goal: PlannerPlan.shape.goal, skills: z.array(PlannerSkill).max(3).default([]),
  focus: z.enum(["6.RP.A.3b", "W.6.1", "7.RP.A.1", "W.7.1"]).optional(),
});

/** Per-district persistence with optimistic concurrency, shared by HTTP and durable adapters. */
export interface PlannerStore {
  list(offeringId: string): Promise<PlannerPlan[]>;
  save(plan: PlannerPlan, expectedRevision: number): Promise<void>;
}
/** Development/test adapter; never used by the deployed district Worker. */
export class InMemoryPlannerStore implements PlannerStore {
  readonly #plans = new Map<string, PlannerPlan>();
  readonly lifecycle: StudentLearningLifecycle | undefined;
  constructor(lifecycle?: StudentLearningLifecycle) { this.lifecycle = lifecycle; }
  /** Internal lifecycle inventory, including classes no longer in the roster. */
  subjectRecords(studentId: string): PlannerPlan[] { return [...this.#plans.values()].filter((p) => p.studentId === studentId); }
  /** Called only by the authorized lifecycle coordinator. */
  eraseSubject(studentId: string): void { for (const p of this.subjectRecords(studentId)) this.#plans.delete(p.id); }
  async list(offeringId: string): Promise<PlannerPlan[]> {
    return structuredClone([...this.#plans.values()].filter((p) => p.offeringId === offeringId));
  }
  async save(raw: PlannerPlan, expectedRevision: number): Promise<void> {
    const plan = PlannerPlan.parse(raw);
    this.lifecycle?.assertWritable(plan.studentId);
    if ((this.#plans.get(plan.id)?.revision ?? 0) !== expectedRevision || plan.revision !== expectedRevision + 1) throw plannerConflict();
    this.#plans.set(plan.id, structuredClone(plan));
  }
}
/** A stale tab must reload rather than silently overwrite evidence or a teacher correction. */
export const plannerConflict = () => new EducateOsError("conflict", "This plan changed. Reload it before trying again.");

/** Redacts private intent even after a learner shares one task response. No chat is ever read. */
export function plannerTeacherView(plan: PlannerPlan): z.infer<typeof PlannerTeacherView> | undefined {
  const { goal, ...rest } = plan;
  // `recipe.matched` is the learner's own words that hit the recipe; teachers see the recipe, not the words.
  const opportunities = (plan.source === "teacher" ? plan.opportunities : plan.opportunities.filter((o) => o.response !== undefined)).map(({ coaching: _coaching, priorEvidence: _prior, recipe, ...o }) => ({ ...o, ...(recipe === undefined ? {} : { recipe: { ...recipe, matched: [] } }), priorEvidence: "Only explicitly shared evidence is included." }));
  return plan.source === "student" && opportunities.length === 0 ? undefined : {
    ...rest, skills: plan.source === "teacher" ? plan.skills : [], opportunities, ...(plan.source === "teacher" ? { invitation: goal } : {}),
  };
}

/** Enforces the evidence floor even when a teacher requests a mastery recommendation. */
export function assertPlannerReview(review: z.infer<typeof PlannerReviewInput>): void {
  if (review.decision === "recommend" && (!review.independentlyAssessed || review.assistance !== "independent" || !["demonstrated", "retained", "transferred"].includes(review.level))) {
    throw new EducateOsError("conflict", "A mastery recommendation needs independently assessed, unassisted demonstrated, retained or transferred evidence.");
  }
}

/** What this learner has already shared for a standard and why now, from their own evidence only; never a mastery claim. */
function plannerPriorEvidence(prior: PlannerPlan[], node: CompetencyNode, releaseDigest: string): string {
  const previous = prior.flatMap((p) => p.opportunities).filter((o) => o.node.uri === node.uri && o.response !== undefined).at(-1);
  const review = previous?.reviews.at(-1);
  const knowledge = prior[0] && plannerKnowledge(prior, prior[0].offeringId, prior[0].studentId).competencies.find((c) => c.competencyUri === node.uri && c.releaseDigest === releaseDigest);
  const evidence = review === undefined ? (previous === undefined ? "No shared planner evidence yet; this is an opportunity to practice, not a mastery claim." : "Previously shared work awaits teacher review; no mastery inferred.") : `Previous teacher observation: ${review.level}; assistance: ${review.assistance}; decision: ${review.decision}. A new context still needs new evidence.`;
  return `${evidence} Current trusted knowledge: ${knowledge?.status ?? "unverified"}. ${knowledge && ["demonstrated", "retained", "transferred"].includes(knowledge.status) ? "Why now: test this skill in a new setting or arrange a delayed check; skip repeated instruction if ready." : "Why now: build the idea with a worked example, then try independently; prerequisites are practice suggestions, not inferred deficits."}`;
}

/**
 * Opportunities from the class's teacher-approved recipes. A recipe is offered when the
 * learner's own words match its criteria, or, for an explicit standards focus, when it is for that
 * standard. At most two are offered, one per standard, best match first; no match offers nothing.
 * Everything the learner sees (task, lesson, rubric, origin) is the approved recipe's text.
 */
export function plannerRecipeOpportunities(recipes: readonly ResolvedRecipe[], goal: string, prior: PlannerPlan[], now: string, focus?: string): PlannerPlan["opportunities"] {
  const chosen = recipes
    .flatMap((r) => {
      if (focus !== undefined) return r.record.content.standard.label === focus ? [{ r, score: 0, matched: [] as string[] }] : [];
      const match = matchRecipeInterest(goal, r.record.content.interest);
      return match === undefined ? [] : [{ r, ...match }];
    })
    .toSorted((a, b) => b.score - a.score || a.r.record.content.standard.label.localeCompare(b.r.record.content.standard.label));
  const seen = new Set<string>();
  const result: PlannerPlan["opportunities"] = [];
  for (const { r, matched } of chosen) {
    if (seen.has(r.node.uri) || result.length >= 2) continue;
    seen.add(r.node.uri);
    const { content, origin, audit } = r.record;
    const approval = audit.findLast((a) => a.action === "approved")!;
    const label = content.standard.label;
    result.push({
      id: crypto.randomUUID(), code: label, frameworkKey: content.standard.frameworkKey, releaseVersion: r.releaseVersion, releaseDigest: r.releaseDigest,
      framework: r.framework, node: r.node,
      reason: focus !== undefined
        ? `You chose ${label} as your focus. ${approval.byName} approved the "${content.title}" recipe for this class; you may skip it.`
        : `Your goal fits "${content.interest.label}". ${approval.byName} approved this recipe so you can practice ${label} through it. This is a teacher-approved connection you may skip.`,
      task: content.studentTask,
      priorEvidence: plannerPriorEvidence(prior, r.node, r.releaseDigest), decision: "offered", reviews: [],
      coaching: { lesson: lessonFromRecipe(content), step: 0, mode: "instruction", hints: 0, events: [], source: "curriculum" },
      recipe: {
        recipeId: r.record.recipeId, version: r.record.version, contentDigest: r.record.contentDigest, title: content.title,
        origin: origin.kind, approvedBy: approval.byName, approvedAt: approval.at, interestLabel: content.interest.label, standardLabel: label,
        whyNow: content.whyNow, prerequisites: content.prerequisites.map((p) => p.concept), coverage: content.coverage, matched,
      },
      contract: EvidenceContract.parse({
        id: EvidenceContractId.parse(`evc_${crypto.randomUUID()}`), version: 1, title: `${label} project evidence`,
        competencies: [{ frameworkUri: r.framework.uri, competencyUri: r.node.uri, frameworkRevision: r.framework.provenance.sourceRevision }],
        responseType: "text", criteria: content.transfer.rubric.map((description, i) => ({ id: `criterion-${i + 1}`, description })),
        restrictions: { aiAssistance: "allowed-with-disclosure", collaboration: "individual" },
        provenance: { source: "district-authored", sourceUri: `urn:educateos:learning-recipe:${r.record.recipeId}`, sourceRevision: String(r.record.version), retrievedAt: now },
      }),
    });
  }
  return result;
}

/** Small, inspectable mappings. Unrecognized goals produce no speculative alignment. */
export async function plannerOpportunities(catalog: CatalogMirror, goal: string, prior: PlannerPlan[], now: string, levels: Set<string> = new Set(["06"]), focus?: string): Promise<PlannerPlan["opportunities"]> {
  const rates = /\b(roblox|pizza|tycoon|cookies?|baking|recipe|sports?|basketball|soccer|running|rates?|speed|price|budget|cost)\b/i.test(goal);
  const argument = /\b(roblox|pizza|tycoon|cookies?|baking|sports?|pet|pets|argue|argument|persuade|convince|proposal)\b/i.test(goal);
  const result: PlannerPlan["opportunities"] = [];
  const selectedGrade = focus?.startsWith("W.") ? focus.split(".")[1] : focus?.[0];
  const grade = selectedGrade && levels.has(selectedGrade.padStart(2, "0")) ? selectedGrade : levels.has("06") ? "6" : levels.has("07") ? "7" : undefined;
  if (grade === undefined) return result;
  for (const match of [
    { key: "ccss-math", nodeCode: grade === "6" ? "6.RP.A.3" : "7.RP.A.1", code: grade === "6" ? "6.RP.A.3b" as const : "7.RP.A.1" as const, matches: rates, task: "Compare two production or purchase options in your project. Record quantity, cost or time, calculate each unit rate with units, predict a new quantity, and explain which option fits your goal. Then solve a fresh unit-rate problem without help.", criteria: ["Calculate both unit rates correctly and label units", "Use a rate to predict a new quantity", "Explain the comparison and solve an unseen unit-rate problem independently"] },
    { key: "ccss-ela", nodeCode: `W.${grade}.1`, code: grade === "6" ? "W.6.1" as const : "W.7.1" as const, matches: argument, task: "Choose a decision in your project. Write a claim, support it with clear reasons and relevant evidence from two credible sources, connect reasons to your claim, use a formal style, and write a conclusion. Explain and defend your reasoning independently to your teacher.", criteria: ["State a claim and organize reasons and relevant evidence clearly", "Use credible sources, linking language, formal style and a conclusion", "Independently explain why the evidence supports the claim"] },
  ]) {
    if (focus === undefined ? !match.matches : match.code !== focus) continue;
    const state = await catalog.get(match.key);
    const approved = state?.releases.find((r) => r.status === "approved");
    if (approved === undefined) continue;
    const node = approved.release.content.nodes?.find((n) => n.humanCodingScheme === match.nodeCode && n.educationLevels?.includes(grade.padStart(2, "0")));
    if (node === undefined || node.fullStatement.trim() === "" || state?.overlays.some((o) => o.nodeUri === node.uri && o.hidden === true)) continue;
    // The catalog has 6.RP.A.3 with its verified lettered components in the statement. Pin that
    // actual node; 6.RP.A.3b is a component label, never a fabricated canonical CASE identifier.
    if (match.code === "6.RP.A.3b" && !node.fullStatement.includes("Solve unit rate problems including those involving unit pricing and constant speed")) continue;
    if (match.code === "7.RP.A.1" && !node.fullStatement.includes("Compute unit rates associated with ratios of fractions")) continue;
    if (match.code === "W.7.1" && !node.fullStatement.includes("acknowledge alternate or opposing claims")) continue;
    const lesson = plannerLesson(match.code);
    result.push({
      id: crypto.randomUUID(), code: match.code, frameworkKey: match.key, releaseVersion: approved.release.version,
      releaseDigest: approved.release.contentDigest, framework: approved.release.content.framework, node,
      reason: focus ? `You chose ${match.code} as your focus. Apply it to a concrete decision in your goal; you may skip this opportunity.` : `Your goal mentions ${rates && match.key === "ccss-math" ? "production, cost or rates" : "a project decision"}. ${match.code} offers ${match.key === "ccss-math" ? "unit-rate reasoning" : "argument writing"} practice. This is a fixed mapping you may skip.`,
      task: grade === "7" ? `${lesson.steps.map((s) => `${s.instruction} ${s.action}`).join(" ")} ${lesson.challenge}` : match.key === "ccss-math" && /\b(pizza|tycoon|roblox)\b/i.test(goal)
        ? "Pizza Tycoon: oven A makes 12 pizzas in 3 minutes; oven B makes 15 in 5 minutes. Calculate pizzas per minute for each oven, predict production after 20 minutes, and explain your choice. Then solve a fresh unit-rate problem without help."
        : match.key === "ccss-math" && /\b(cookies?|baking|recipe)\b/i.test(goal)
          ? "Cookie project: compare 12 cookies for $6 with 20 for $8. Calculate cost per cookie, predict the cost of 30 at each rate, and explain your choice. Then solve a fresh unit-price problem without help."
          : match.key === "ccss-math" && /\b(basketball|free throws?|soccer|running)\b/i.test(goal)
            ? "Basketball practice: in drill A you make 18 free throws in 6 minutes; in drill B you make 14 in 4 minutes. Calculate free throws per minute for each drill, predict makes in 20 minutes of practice, and explain which drill fits your goal. Then solve a fresh unit-rate problem without help."
            : match.task,
      priorEvidence: plannerPriorEvidence(prior, node, approved.release.contentDigest), decision: "offered", reviews: [],
      coaching: { lesson, step: 0, mode: "instruction", hints: 0, events: [], source: "curriculum" },
      contract: EvidenceContract.parse({
        id: EvidenceContractId.parse(`evc_${crypto.randomUUID()}`), version: 1, title: `${match.code} project evidence`,
        competencies: [{ frameworkUri: approved.release.content.framework.uri, competencyUri: node.uri, frameworkRevision: approved.release.content.framework.provenance.sourceRevision }],
        responseType: "text", criteria: (grade === "7" ? [...match.criteria, match.key === "ccss-math" ? "Compute unit rates involving ratios of fractions with correct units" : "Acknowledge alternate or opposing claims and respond using relevant evidence"] : match.criteria).map((description, i) => ({ id: `criterion-${i + 1}`, description })),
        restrictions: { aiAssistance: "allowed-with-disclosure", collaboration: "individual" },
        provenance: { source: "district-authored", sourceUri: "urn:educateos:personalized-learning-planner:v1", sourceRevision: "1", retrievedAt: now },
      }),
    });
  }
  return result;
}
