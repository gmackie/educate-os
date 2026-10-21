import { z } from "zod";
import { ContentDigest, PrincipalId, RubricId, SchoolOsError, type Caller } from "@schoolos/contracts";
import { CriterionId, type RubricReleaseRef } from "@schoolos/assessment";
import { canonicalDigest } from "./canonical.ts";
import type { EvaluatorRegistry } from "./registry.ts";
import { EvaluatorId } from "./sdk.ts";

const LocalId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "expected lowercase letters, digits and dashes");

/**
 * Who sees a check's evidence. `student-visible` evidence is shown to the student as CI feedback;
 * `teacher-only` evidence, and every check bound to an answer key or fixture, is never shown to them.
 */
export const CheckVisibility = z.enum(["student-visible", "teacher-only"]);
/** A check visibility. */
export type CheckVisibility = z.infer<typeof CheckVisibility>;

/** One evaluator bound to a criterion with its config. The config may hold answer keys, so it is teacher-only data. */
export const RubricCheck = z.strictObject({
  id: LocalId,
  evaluatorId: EvaluatorId,
  visibility: CheckVisibility,
  config: z.json(),
});
/** A rubric check. */
export type RubricCheck = z.infer<typeof RubricCheck>;

/** A performance level of a criterion, worth `points`. */
export const RubricLevel = z.strictObject({
  id: LocalId,
  label: z.string().trim().min(1).max(200),
  points: z.number().nonnegative().max(1000),
});
/** A rubric level. */
export type RubricLevel = z.infer<typeof RubricLevel>;

/** A rubric criterion: its levels, lowest first, and the checks that gather evidence for it. */
export const RubricCriterion = z.strictObject({
  id: CriterionId,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000).optional(),
  levels: z.array(RubricLevel).min(1).max(10).refine(
    (levels) => levels.every((level, i) => i === 0 || level.points > levels[i - 1]!.points),
    "levels are listed lowest first, each worth more points than the one before",
  ).refine((levels) => new Set(levels.map((l) => l.id)).size === levels.length, "level IDs are unique"),
  checks: z.array(RubricCheck).max(20),
});
/** A rubric criterion. */
export type RubricCriterion = z.infer<typeof RubricCriterion>;

const rubricBody = {
  rubricId: RubricId,
  version: z.int().positive(),
  title: z.string().trim().min(1).max(200),
  criteria: z.array(RubricCriterion).min(1).max(50),
};

function uniqueIds(rubric: { criteria: readonly RubricCriterion[] }): boolean {
  const criteria = rubric.criteria.map((c) => c.id);
  const checks = rubric.criteria.flatMap((c) => c.checks.map((k) => k.id));
  return new Set(criteria).size === criteria.length && new Set(checks).size === checks.length;
}

/** A rubric release as a teacher authors it, before signing. */
export const RubricDraft = z.strictObject(rubricBody).refine(uniqueIds, "criterion IDs, and check IDs, are unique within a rubric");
/** A rubric draft. */
export type RubricDraft = z.infer<typeof RubricDraft>;

/**
 * The teacher's approval of a rubric release: who approved it, when, and the digest of exactly what
 * they approved. It is an approval record, not a cryptographic signature: what makes it the
 * teacher's is that only a teacher acting directly through SchoolOS can produce one, and the digest
 * makes any later change to the release detectable.
 */
export const RubricSignature = z.strictObject({
  signedBy: PrincipalId,
  signedAt: z.iso.datetime(),
  channel: z.literal("http"),
  /** SHA-256 over the canonical JSON of the release without its signature (see {@link rubricDigest}). */
  digest: ContentDigest,
});
/** A rubric signature. */
export type RubricSignature = z.infer<typeof RubricSignature>;

/**
 * One signed, immutable release of a rubric (roadmap §7): its criteria, their levels, and the
 * evaluator checks bound to each. A submission names the release it is assessed against with a
 * `RubricReleaseRef`, which the assessment service locks once the assignment has a submission;
 * since a release itself never changes, that lock fixes exactly which checks and fixtures apply.
 */
export const RubricRelease = z.strictObject({
  format: z.literal("schoolos.rubric-release.v1"),
  ...rubricBody,
  signature: RubricSignature,
}).refine(uniqueIds, "criterion IDs, and check IDs, are unique within a rubric");
/** A rubric release. */
export type RubricRelease = z.infer<typeof RubricRelease>;

/** The digest a rubric signature covers: everything in the release except the signature. */
export async function rubricDigest(release: RubricDraft): Promise<ContentDigest> {
  const { rubricId, version, title, criteria } = release;
  return canonicalDigest({ format: "schoolos.rubric-release.v1", rubricId, version, title, criteria });
}

/** The reference a submission uses to name `release`. */
export function rubricRef(release: RubricDraft): RubricReleaseRef {
  return { rubricId: release.rubricId, version: release.version };
}

/**
 * Signs a teacher's rubric draft, making it a release. Only a person acting directly through the
 * SchoolOS UI or API can sign: an agent or tool may draft a rubric but never approve one. Every
 * check's config must be valid for the evaluator release `registry` pins, and a check bound to an
 * answer-keyed evaluator must be `teacher-only`.
 */
export async function signRubricRelease(rawDraft: RubricDraft, signer: Caller, registry: EvaluatorRegistry, signedAt: Date): Promise<RubricRelease> {
  if (signer.channel !== "http") throw new SchoolOsError("forbidden", "A rubric is signed only by a teacher acting directly in SchoolOS.");
  const parsed = RubricDraft.safeParse(rawDraft);
  if (!parsed.success) throw new SchoolOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  const draft = parsed.data;
  for (const criterion of draft.criteria) {
    for (const check of criterion.checks) {
      const evaluator = registry.pinned(check.evaluatorId);
      if (evaluator.answerKeyed && check.visibility !== "teacher-only") {
        throw new SchoolOsError("policy-violation", `Check ${check.id} holds an answer key or fixture, so it must be teacher-only.`);
      }
      const config = evaluator.config.safeParse(check.config);
      if (!config.success) {
        throw new SchoolOsError("validation-failed", `Check ${check.id} has an invalid ${check.evaluatorId} config: ${z.prettifyError(config.error)}`.slice(0, 1000));
      }
    }
  }
  return {
    format: "schoolos.rubric-release.v1",
    ...draft,
    signature: { signedBy: signer.principal.principalId, signedAt: signedAt.toISOString(), channel: "http", digest: await rubricDigest(draft) },
  };
}

/** Checks that `release` is exactly what its signer approved, answering `policy-violation` if not. */
export async function verifyRubricRelease(release: RubricRelease): Promise<void> {
  if (!RubricRelease.safeParse(release).success || (await rubricDigest(release)) !== release.signature.digest) {
    throw new SchoolOsError("policy-violation", `Rubric ${release.rubricId} version ${release.version} does not match its signature.`);
  }
}

/** A rubric as its students see it: criteria and levels, and only the student-visible checks, with no config. */
export interface StudentRubricView {
  rubricId: RubricId;
  version: number;
  title: string;
  criteria: {
    id: CriterionId;
    title: string;
    description?: string;
    levels: RubricLevel[];
    checks: { id: string; evaluatorId: EvaluatorId }[];
  }[];
}

/** {@link StudentRubricView} of `release`. Configs never leave the teacher side, since any may hold a fixture. */
export function studentRubricView(release: RubricRelease): StudentRubricView {
  return {
    rubricId: release.rubricId,
    version: release.version,
    title: release.title,
    criteria: release.criteria.map((c) => ({
      id: c.id,
      title: c.title,
      ...(c.description === undefined ? {} : { description: c.description }),
      levels: c.levels,
      checks: c.checks.filter((k) => k.visibility === "student-visible").map((k) => ({ id: k.id, evaluatorId: k.evaluatorId })),
    })),
  };
}

/** Where signed rubric releases are kept. Teacher-side storage: never a student's workspace. */
export interface RubricReleaseStore {
  /** The release `ref` names, if stored. */
  get(ref: RubricReleaseRef): Promise<RubricRelease | undefined>;
  /**
   * Stores a signed release. Storing the same content again is a no-op that keeps the first
   * signature; storing different content under a stored release's ID and version answers
   * `conflict`, since a release never changes.
   */
  put(release: RubricRelease): Promise<void>;
}

/** A {@link RubricReleaseStore} in memory, for tests and local development. */
export class InMemoryRubricReleaseStore implements RubricReleaseStore {
  readonly #releases = new Map<string, string>();

  async get(ref: RubricReleaseRef): Promise<RubricRelease | undefined> {
    const stored = this.#releases.get(`${ref.rubricId}@${ref.version}`);
    return stored === undefined ? undefined : RubricRelease.parse(JSON.parse(stored));
  }

  async put(release: RubricRelease): Promise<void> {
    await verifyRubricRelease(release);
    const key = `${release.rubricId}@${release.version}`;
    const existing = await this.get(release);
    if (existing !== undefined) {
      // The same content signed again keeps the first approval.
      if (existing.signature.digest === release.signature.digest) return;
      throw new SchoolOsError("conflict", `Rubric ${release.rubricId} version ${release.version} is already released and cannot change.`);
    }
    this.#releases.set(key, JSON.stringify(release));
  }
}
