// Verifies learning recipes against the district's approved standards. Server side: it
// reads the catalog mirror. A recipe is usable for students only while every check here passes
// against the CURRENT approved release, so a withdrawn, replaced or hidden standard retires the
// recipe's offers without anyone editing the recipe. No identifier or mapping is ever invented:
// the item must already exist, by its published code, in the release the district approved.
import { CATALOG, type CatalogMirror } from "@educateos/catalog";
import type { DistrictDirectorySnapshot, OfferingId, Subject } from "@educateos/contracts";
import type { CompetencyNode, FrameworkDefinition } from "@educateos/registry";
import type { GuidanceRecord } from "./guidance.ts";
import type { LearningRecipeRecord, LearningRecipeSettings, RecipeCheckState, RecipeContent } from "./learning-recipe.ts";
import { catalogSubjectOf, educationLevelsOf } from "./standards.ts";

/** The class a recipe is checked against: its course's subject and grade levels. */
export interface RecipeClass { subject: Subject | undefined; levels: Set<string> | undefined }

/** The class's course, or nothing known about it. */
export function recipeClassOf(snapshot: Pick<DistrictDirectorySnapshot, "offerings" | "courses">, offeringId: OfferingId): RecipeClass {
  const offering = snapshot.offerings.find((o) => o.id === offeringId);
  const course = offering === undefined ? undefined : snapshot.courses.find((c) => c.id === offering.courseId);
  return { subject: course?.subject, levels: course === undefined ? undefined : educationLevelsOf(course.gradeBand) };
}

/** The standards check for one recipe: the pinned catalog item on success, otherwise why it is not usable. */
export type RecipeStandardCheck =
  | { ok: true; state: "ok"; framework: FrameworkDefinition; node: CompetencyNode; releaseVersion: string; releaseDigest: string; message: string }
  | { ok: false; state: Exclude<RecipeCheckState, "ok">; message: string };

/**
 * Checks `content`'s standard against the district's approved release for this class. With `pinnedDigest`
 * (an earlier approval) the release must be the very one that approval verified: a newer release means
 * the recipe has to be reviewed again.
 */
export async function verifyRecipeStandard(catalog: CatalogMirror, content: RecipeContent, klass: RecipeClass, pinnedDigest?: string): Promise<RecipeStandardCheck> {
  const { standard } = content;
  const fail = (state: Exclude<RecipeCheckState, "ok">, message: string): RecipeStandardCheck => ({ ok: false, state, message });
  const entry = CATALOG.find((e) => e.key === standard.frameworkKey);
  if (entry === undefined) return fail("unknown-framework", `${standard.frameworkKey} is not a standards framework in the EducateOS catalog.`);
  const subject = klass.subject === undefined ? undefined : catalogSubjectOf(klass.subject);
  if (subject === undefined || !entry.subjects.includes(subject)) return fail("subject-mismatch", `${entry.framework.title} does not cover this class's subject.`);
  const mirror = await catalog.get(standard.frameworkKey);
  const approved = mirror?.releases.find((r) => r.status === "approved");
  if (mirror === undefined || approved === undefined) return fail("not-approved", `${entry.framework.title} is not approved for this district. A district administrator approves standards first; no mapping is assumed.`);
  const nodes = approved.release.content.nodes ?? [];
  const candidates = nodes.filter((n) => n.humanCodingScheme === standard.code && n.fullStatement.trim() !== "");
  if (candidates.length === 0) return fail("item-not-found", `The approved ${entry.framework.title} release has no item ${standard.code}. No mapping is assumed.`);
  const node = candidates.find((n) => standard.gradeLevels.some((l) => n.educationLevels?.includes(l))) ?? candidates[0]!;
  if (!standard.gradeLevels.some((l) => node.educationLevels?.includes(l)) || klass.levels === undefined || !standard.gradeLevels.some((l) => klass.levels!.has(l))) {
    return fail("grade-mismatch", `${standard.label} is for grade ${standard.gradeLevels.join(", ")}, which this class does not cover.`);
  }
  if (mirror.overlays.some((o) => o.nodeUri === node.uri && o.hidden === true)) return fail("hidden", `${standard.code} is hidden by this district.`);
  if (standard.statementIncludes !== undefined && !node.fullStatement.includes(standard.statementIncludes)) return fail("statement-mismatch", `${standard.label} names text the approved ${standard.code} statement does not contain.`);
  for (const prerequisite of content.prerequisites) {
    if (prerequisite.standardCode !== undefined && !nodes.some((n) => n.humanCodingScheme === prerequisite.standardCode)) return fail("prerequisite-missing", `The prerequisite standard ${prerequisite.standardCode} is not in the approved release.`);
  }
  if (pinnedDigest !== undefined && pinnedDigest !== approved.release.contentDigest) return fail("stale", "The district approved a different standards release after this recipe was approved. Review it again.");
  return { ok: true, state: "ok", framework: approved.release.content.framework, node, releaseVersion: approved.release.version, releaseDigest: approved.release.contentDigest, message: `Matches ${node.humanCodingScheme} in the approved ${entry.framework.title} release ${approved.release.version}.` };
}

/** A class recipe that passed every check just now, with the catalog item it pins. */
export interface ResolvedRecipe {
  record: LearningRecipeRecord;
  framework: FrameworkDefinition; node: CompetencyNode; releaseVersion: string; releaseDigest: string;
}

/** The newest version of each recipe in a class, newest first. */
export function latestRecipes(records: readonly GuidanceRecord[]): LearningRecipeRecord[] {
  const latest = new Map<string, LearningRecipeRecord>();
  for (const r of records) if (r.type === "recipe" && (latest.get(r.recipeId)?.version ?? 0) < r.version) latest.set(r.recipeId, r);
  return [...latest.values()];
}

/**
 * What a class's recipes allow right now. `engaged` is true once a teacher has made any recipe
 * decision or setting; from then on only approved recipes connect interests to standards. A paused
 * class resolves nothing.
 */
export async function resolveClassRecipes(catalog: CatalogMirror, records: readonly GuidanceRecord[], klass: RecipeClass): Promise<{ engaged: boolean; paused: boolean; resolved: ResolvedRecipe[] }> {
  const settings = records.find((r): r is LearningRecipeSettings => r.type === "recipe-settings");
  const latest = latestRecipes(records);
  const paused = settings?.paused === true;
  const resolved: ResolvedRecipe[] = [];
  if (!paused) {
    for (const record of latest.filter((r) => r.status === "approved")) {
      const check = await verifyRecipeStandard(catalog, record.content, klass, record.pin?.releaseDigest);
      if (check.ok) resolved.push({ record, framework: check.framework, node: check.node, releaseVersion: check.releaseVersion, releaseDigest: check.releaseDigest });
    }
  }
  return { engaged: latest.length > 0 || settings !== undefined, paused, resolved };
}
