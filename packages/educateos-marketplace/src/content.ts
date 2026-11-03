// What a curriculum pack listing delivers (SCHO-209): activity templates a teacher turns into a
// draft activity in their own class through the curriculum service. A pack is self-contained, so
// it never names anything that exists only in the district that authored it.
import { GradeBand, Subject } from "@educateos/contracts";
import { canonicalJson } from "@educateos/fleet";
import { TemplateInput } from "@educateos/curriculum";
import { z } from "zod";

const Text = (max: number) => z.string().trim().min(1).max(max);

// Each refers to a release, rubric or approved standard in the publisher's own registry, which the
// installing district does not have. A teacher adds their own after creating the activity.
const RUBRIC_FIELDS = ["structureRubric", "investigationRubric", "analysisRubric", "solutionRubric", "pictureRubric", "responseRubric"] as const;

/**
 * One activity in a pack: a curriculum template's inputs, under a key unique in the pack.
 * Primary-source analyses are left out, because their sources are resource releases; so are
 * resources, Codex resource entries, alignments and rubrics. Codex notes are kept.
 */
export const PackActivity = z
  .strictObject({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "expected a lowercase slug"),
    template: TemplateInput,
  })
  .superRefine(({ template }, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: ["template", path], message });
    if (template.template === "primary-source-analysis") issue("template", "a pack cannot carry a primary-source analysis: its sources are district resources");
    if (template.resources.length > 0) issue("resources", "a pack activity cannot name resource releases");
    if (template.alignments.length > 0) issue("alignments", "a pack activity cannot name learning goals");
    if (template.codex.some((entry) => entry.kind === "resource")) issue("codex", "a pack activity's Codex holds notes only");
    for (const field of RUBRIC_FIELDS) {
      if (field in template && (template as Record<string, unknown>)[field] !== undefined) issue(field, "a pack activity cannot name a rubric");
    }
  });
/** A pack activity. */
export type PackActivity = z.infer<typeof PackActivity>;

/** The content of a curriculum pack listing. */
export const CurriculumPackContent = z
  .strictObject({
    title: Text(200),
    description: Text(5000).optional(),
    subjects: z.array(Subject).min(1).max(12),
    gradeBands: z.array(GradeBand).min(1).max(14),
    activities: z.array(PackActivity).min(1).max(50),
  })
  .refine((pack) => new Set(pack.activities.map((a) => a.key)).size === pack.activities.length, {
    path: ["activities"],
    message: "each activity key appears in a pack at most once",
  });
/** A curriculum pack's content. */
export type CurriculumPackContent = z.infer<typeof CurriculumPackContent>;

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The `sha256:<hex>` digest of a value's canonical JSON, as catalog and registry releases name
 * their content. A listing names its content by this digest, so the bytes delivered beside it can
 * be checked before they are parsed.
 */
export async function listingContentDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes))}`;
}
