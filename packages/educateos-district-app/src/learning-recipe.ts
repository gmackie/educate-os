// Educator-reviewed learning recipes: a versioned, provenance-carrying way to connect a
// learner's stated interest to one approved standard. A recipe is content a teacher read, edited
// if needed and approved for their class; the planner never accepts a raw model guess in its place.
// Browser-safe: schemas, the pure goal matcher and the lesson mapping only. Catalog verification
// and persistence rules live in `learning-recipe-approval.ts` and `guidance-routes.ts`.
//
// What the types themselves encode:
//   - a recipe record's `content` never changes after it is saved; an edit is a new `version`;
//   - an approval pins the exact approved standards release digest it was verified against;
//   - nothing here carries a mastery, score, sentiment or trait field.
import { z } from "zod";
import { OfferingId, PrincipalId } from "@educateos/contracts";
import type { PlannerLesson } from "./planner-coaching.ts";

/** Plain words: no links, email addresses or phone numbers in student-facing recipe text. */
const Plain = (max: number) => z.string().trim().min(1).max(max).refine((text) => !/(https?:\/\/|www\.|@\S+\.\S+|\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b)/i.test(text), "Use plain words: no links, email addresses or phone numbers.");
const Term = Plain(40).refine((term) => term.length >= 2, "A matching term needs at least two characters.");

/**
 * When a learner's own words connect to a standard. `anyOf` names the interest; `alsoRequireAnyOf`
 * names the project hook that makes the standard genuinely useful there (a quantity, a price, a
 * decision). A goal that has the interest but no hook matches nothing, so no weak connection is forced.
 */
export const RecipeInterest = z.strictObject({
  domain: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  label: Plain(60),
  anyOf: z.array(Term).min(1).max(30),
  alsoRequireAnyOf: z.array(Term).max(40),
  exclude: z.array(Term).max(20),
});
/** One worked step the learner can act on right away, with escalating hints. */
export const RecipeStep = z.strictObject({
  title: Plain(80), instruction: Plain(600), action: Plain(400), example: Plain(600), hints: z.array(Plain(300)).min(1).max(3),
});
/**
 * The reusable teaching content. `standard` names a catalog framework key and the item's published
 * code as the district's approved release spells it. A recipe never carries a canonical identifier:
 * approval looks the item up and pins it. `statementIncludes` must appear verbatim in the item's
 * statement, which is how a component label such as `6.RP.A.3b` is verified instead of invented.
 */
export const RecipeContent = z.strictObject({
  title: Plain(100),
  standard: z.strictObject({
    frameworkKey: z.string().trim().min(1).max(100), code: Plain(30), label: Plain(30),
    gradeLevels: z.array(z.string().regex(/^(KG|\d{2})$/)).min(1).max(3), statementIncludes: Plain(300).optional(),
  }),
  interest: RecipeInterest,
  whyNow: Plain(500),
  /** Practice suggestions the learner may want first. They are never a diagnosis and never gate the recipe. */
  prerequisites: z.array(z.strictObject({ concept: Plain(120), standardCode: z.string().trim().min(1).max(30).optional() })).min(1).max(5),
  steps: z.array(RecipeStep).min(1).max(4),
  studentTask: Plain(1200),
  /** Practice the learner may attempt without help; not an unseen assessment. */
  independentChallenge: Plain(800),
  /** A teacher-selected check in a new context, scored against this rubric. */
  transfer: z.strictObject({ prompt: Plain(600), rubric: z.array(Plain(300)).min(2).max(6) }),
  /** What this recipe does not cover, shown with the standard. */
  coverage: Plain(400),
});
/** Recipe content. */
export type RecipeContent = z.infer<typeof RecipeContent>;

/** Where a recipe's words came from. A starter is unreviewed EducateOS content until a teacher approves it. */
export const RecipeOrigin = z.strictObject({ kind: z.enum(["starter", "starter-edited", "teacher"]), starterId: z.string().optional(), starterDigest: z.string().optional() });
/** The approved catalog item an approval was verified against. */
export const RecipePin = z.strictObject({ competencyUri: z.string(), releaseVersion: z.string(), releaseDigest: z.string() });
/** One entry of a recipe's append-only audit trail. */
export const RecipeAudit = z.strictObject({
  action: z.enum(["approved", "rejected", "withdrawn", "superseded"]), by: PrincipalId, byName: z.string(), at: z.iso.datetime(), note: Plain(300).optional(),
});

/**
 * One version of one recipe in one class. `content` and `contentDigest` are fixed at creation;
 * only `status` and `audit` change afterwards (a withdrawal), so an approval cannot be rewritten.
 */
export const LearningRecipeRecord = z.strictObject({
  type: z.literal("recipe"), id: z.string().uuid(), scope: z.string(), revision: z.number().int().positive(), offeringId: OfferingId,
  recipeId: z.string().uuid(), version: z.number().int().positive(), status: z.enum(["approved", "rejected", "withdrawn"]),
  content: RecipeContent, contentDigest: z.string(), origin: RecipeOrigin, pin: RecipePin.optional(), audit: z.array(RecipeAudit).min(1).max(50),
});
/** A stored recipe version. */
export type LearningRecipeRecord = z.infer<typeof LearningRecipeRecord>;
/** A class's teacher-controlled switch. Paused means no recipe or fixed mapping creates opportunities. */
export const LearningRecipeSettings = z.strictObject({
  type: z.literal("recipe-settings"), id: z.string(), scope: z.string(), revision: z.number().int().positive(), offeringId: OfferingId,
  paused: z.boolean(), updated: z.strictObject({ by: PrincipalId, byName: z.string(), at: z.iso.datetime() }),
});
/** A class's recipe switch. */
export type LearningRecipeSettings = z.infer<typeof LearningRecipeSettings>;

/** Why a recipe is or is not usable in a class right now. Each state is a refusal; none is inferred or repaired. */
export const RecipeCheckState = z.enum(["ok", "unknown-framework", "subject-mismatch", "not-approved", "item-not-found", "grade-mismatch", "hidden", "statement-mismatch", "prerequisite-missing", "stale"]);
/** A recipe check state. */
export type RecipeCheckState = z.infer<typeof RecipeCheckState>;

/** What a learner is shown about an opportunity that came from a recipe. No private goal text is kept here. */
export const RecipeProvenance = z.strictObject({
  recipeId: z.string().uuid(), version: z.number().int().positive(), contentDigest: z.string(), title: z.string(),
  origin: RecipeOrigin.shape.kind, approvedBy: z.string(), approvedAt: z.iso.datetime(),
  interestLabel: z.string(), standardLabel: z.string(), whyNow: z.string(), prerequisites: z.array(z.string()), coverage: z.string(),
  /** The recipe's own matching words that appeared in the learner's goal. Withheld from teachers. */
  matched: z.array(z.string()),
});
/** A recipe's provenance on an opportunity. */
export type RecipeProvenance = z.infer<typeof RecipeProvenance>;

// Teacher routes

/** One recipe as a teacher reviews it: the exact text a student would see, where it came from and whether it is usable now. */
export const TeacherRecipeEntry = z.strictObject({
  /** The class's recipe (stable across versions), if a teacher has decided on it. */
  recipeId: z.string().uuid().optional(),
  starterId: z.string().optional(),
  version: z.number().int().nonnegative(),
  /** The stored record's revision (0 when no decision exists); a decision must quote it. */
  revision: z.number().int().nonnegative(),
  status: z.enum(["unreviewed", "approved", "rejected", "withdrawn"]),
  content: RecipeContent, contentDigest: z.string(), origin: RecipeOrigin,
  standardCheck: z.strictObject({ state: RecipeCheckState, message: z.string() }),
  audit: z.array(RecipeAudit),
});
/** The teacher's recipes page for one class. */
export const TeacherRecipesBody = z.strictObject({
  paused: z.boolean(), settingsRevision: z.number().int().nonnegative(),
  /** True once the class has made any recipe decision; from then on only approved recipes create opportunities. */
  engaged: z.boolean(),
  entries: z.array(TeacherRecipeEntry),
  note: z.string(),
});
/** A teacher's decision on one recipe: approve (optionally with edited content), reject, or withdraw an approval. */
export const RecipeDecisionInput = z.strictObject({
  decision: z.enum(["approve", "reject", "withdraw"]),
  starterId: z.string().min(1).max(80).optional(),
  recipeId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative(),
  content: RecipeContent.optional(),
  note: Plain(300).optional(),
});

// Goal matching

const NEGATORS = new Set(["no", "not", "dont", "don't", "never", "without", "hate", "hates", "hated", "avoid", "stop"]);
const tokens = (text: string) => text.toLowerCase().replace(/[^a-z0-9/'\s-]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter((t) => t !== "");
/** Strips one plural, tense or silent-e suffix so "baking", "baked" and "bake" meet. */
const stem = (word: string) => {
  for (const suffix of ["ing", "ers", "er", "ed", "es", "s", "e"]) if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  return word;
};

/** How well a goal fits a recipe's interest, and which of the recipe's own words it used. */
export interface RecipeMatch { score: number; matched: string[] }

/**
 * Matches a learner's goal against a recipe's criteria. Deterministic and inspectable: a hit needs
 * the interest AND (if the recipe names one) a project hook, a negated word ("I don't want to make a
 * pizza tycoon") counts for nothing, and any excluded term vetoes the match. No semantic guessing.
 */
export function matchRecipeInterest(goal: string, interest: z.infer<typeof RecipeInterest>): RecipeMatch | undefined {
  const raw = tokens(goal);
  const stems = raw.map(stem);
  const hit = (term: string) => {
    const wanted = tokens(term).map(stem);
    if (wanted.length === 0) return false;
    for (let i = 0; i + wanted.length <= stems.length; i++) {
      if (wanted.every((w, j) => stems[i + j] === w) && !raw.slice(Math.max(0, i - 6), i).some((w) => NEGATORS.has(w))) return true;
    }
    return false;
  };
  if (interest.exclude.some(hit)) return undefined;
  const primary = interest.anyOf.filter(hit);
  if (primary.length === 0) return undefined;
  const hooks = interest.alsoRequireAnyOf.filter(hit);
  if (interest.alsoRequireAnyOf.length > 0 && hooks.length === 0) return undefined;
  return { score: primary.length + hooks.length / 2, matched: [...primary, ...hooks] };
}

/** The coaching lesson a recipe provides: the same shape the planner's reviewed lessons use. */
export function lessonFromRecipe(content: RecipeContent): z.infer<typeof PlannerLesson> {
  return {
    version: 1, prerequisites: content.prerequisites.map((p) => p.concept), coverage: content.coverage,
    steps: content.steps.map((s) => ({ title: s.title, instruction: s.instruction, action: s.action, example: s.example, hints: [...s.hints] })),
    challenge: content.independentChallenge, transfer: content.transfer.prompt,
  };
}
