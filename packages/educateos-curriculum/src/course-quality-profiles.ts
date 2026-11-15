// Detached experimental course-quality profiles. Neither changes OCS 1.1 package bytes.
// These describe author intent and *claims* about quality, never authorization, proof of
// student outcomes, a legal license, or cryptographic verification of their issuer.
import { z } from "zod";

const active = /<\s*\/?\s*(script|iframe|object|embed|applet|style|link|meta|base|form|svg)\b|\b(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i;
const plain = (max: number) => z.string().trim().min(1).max(max).refine(
  (v) => !active.test(v), "Course metadata must not carry active markup.",
);
const localId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const semver = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Source must also be checked against the recipient district's trusted OCS library. */
export const CoursePublicationRef = z.strictObject({
  packageId: z.string().min(1).max(200).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\/[a-z][a-z0-9-]{0,62}$/),
  version: semver,
  digest,
});
export type CoursePublicationRef = z.infer<typeof CoursePublicationRef>;

/** One author-declared alignment; this doesn't establish CASE equivalence. */
export const IntentAlignment = z.strictObject({
  frameworkKey: plain(100),
  competencyUri: z.string().min(1).max(2048).refine((s) => URL.canParse(s) && !/\s/.test(s)),
});
const Goal = z.strictObject({
  id: localId,
  statement: plain(1500),
  alignments: z.array(IntentAlignment).max(10).default([]),
});
const Strategy = z.strictObject({
  id: localId,
  approach: plain(1000),
  rationale: plain(1500).optional(),
  conditions: z.array(plain(500)).max(15).default([]),
});
const ExpectedDemonstration = z.strictObject({
  id: localId,
  goalId: localId,
  observable: plain(1500),
  modality: z.enum(["explain", "demonstrate", "create", "apply", "other"]),
});

/** Optional teacher/AI *draft* profile. No grade band or school required. */
export const PedagogicalIntentV0 = z.strictObject({
  profile: z.literal("educateos.pedagogical-intent/0.1"),
  id: localId,
  revision: semver,
  source: CoursePublicationRef.extend({ unitKey: z.string().min(1).max(500).optional() }),
  origin: z.enum(["educator-draft", "machine-suggestion"]),
  learningGoals: z.array(Goal).min(1).max(25),
  prerequisites: z.array(plain(500)).max(25).default([]),
  misconceptions: z.array(plain(500)).max(25).default([]),
  strategies: z.array(Strategy).max(15).default([]),
  expectedDemonstrations: z.array(ExpectedDemonstration).min(1).max(40),
  constraints: z.strictObject({
    suggestedMinutes: z.int().positive().max(10080).optional(),
    equipment: z.array(plain(200)).max(40).default([]),
    accessibilityConsiderations: z.array(plain(500)).max(20).default([]),
  }).optional(),
}).superRefine((draft, ctx) => {
  const goalIds = new Set(draft.learningGoals.map((g) => g.id));
  for (const [index, evidence] of draft.expectedDemonstrations.entries()) {
    if (!goalIds.has(evidence.goalId)) ctx.addIssue({
      code: "custom", path: ["expectedDemonstrations", index, "goalId"],
      message: "An expected demonstration must reference an existing goal.",
    });
  }
  for (const key of ["learningGoals", "strategies", "expectedDemonstrations"] as const) {
    const seen = new Set<string>();
    for (const [i, entry] of draft[key].entries()) {
      if (seen.has(entry.id)) ctx.addIssue({
        code: "custom", path: [key, i, "id"], message: "Duplicate ID.",
      });
      seen.add(entry.id);
    }
  }
});
export type PedagogicalIntentV0 = z.infer<typeof PedagogicalIntentV0>;

export const EvidenceDimension = z.enum([
  "package-integrity", "standards-reference", "resource-attribution",
  "copyright-rights", "accessibility", "subject-accuracy",
  "instructional-design", "classroom-use", "learning-outcomes",
]);
const Claim = z.strictObject({
  id: localId,
  dimension: EvidenceDimension,
  finding: z.enum(["pass", "attention", "not-verified", "study-reported"]),
  basis: z.enum(["deterministic-check", "educator-review", "research-publication", "self-report", "model-suggestion"]),
  method: plain(500),
  methodVersion: z.string().min(1).max(80),
  summary: plain(1500),
  reportedAt: z.iso.datetime({ offset: true }),
  /** Merely a name: identity/authority must be verified by a separate receiving service. */
  issuer: z.strictObject({ organization: plain(200), actor: plain(200).optional() }),
}).superRefine((claim, ctx) => {
  const refuse = (message: string) => ctx.addIssue({ code: "custom", path: ["finding"], message });
  if (claim.finding === "pass" && (claim.basis === "model-suggestion" || claim.basis === "self-report")) {
    refuse("Self-report and model output cannot confer a passing verification.");
  }
  if (claim.finding === "pass" && claim.dimension === "learning-outcomes") {
    refuse("A passport cannot declare student learning outcomes passed.");
  }
  if (claim.finding === "pass" && claim.basis === "deterministic-check" &&
      !["package-integrity", "standards-reference", "resource-attribution"].includes(claim.dimension)) {
    refuse("Technical checks cannot certify legal rights, accessibility or instructional quality.");
  }
  if (claim.finding === "study-reported" &&
      (claim.dimension !== "learning-outcomes" || claim.basis !== "research-publication")) {
    refuse("Study-reported is limited to a learning-outcomes claim with a research publication.");
  }
  if (claim.basis === "model-suggestion" && claim.finding !== "not-verified") {
    refuse("A model suggestion must remain not verified.");
  }
});

/** Version-bound claims. These fields are deliberately not a certification or rights grant. */
export const EvidencePassportV0 = z.strictObject({
  profile: z.literal("educateos.evidence-passport/0.1"),
  subject: CoursePublicationRef,
  createdAt: z.iso.datetime({ offset: true }),
  independentlyVerified: z.literal(false),
  publicationApproved: z.literal(false),
  claims: z.array(Claim).max(100),
}).superRefine((record, ctx) => {
  const ids = new Set<string>();
  for (const [i, c] of record.claims.entries()) {
    if (ids.has(c.id)) ctx.addIssue({ code: "custom", path: ["claims", i, "id"], message: "Duplicate claim ID." });
    ids.add(c.id);
  }
});
export type EvidencePassportV0 = z.infer<typeof EvidencePassportV0>;

/** Reject a mismatched source after the caller independently verifies OCS publication. */
export function assertProfileSource(
  subject: CoursePublicationRef,
  verified: CoursePublicationRef,
): void {
  if (subject.packageId !== verified.packageId
      || subject.version !== verified.version
      || subject.digest !== verified.digest) {
    throw new Error("Course quality profile does not match the verified OCS publication.");
  }
}
