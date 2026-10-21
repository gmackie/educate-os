import { ActivityId, GradeBand, PrincipalId, RubricId, Subject, TermId } from "@schoolos/contracts";
import { EvidenceContract, ImmutableRelease, ObservableCriterion, RegistryUri, ResourceId, ResponseType } from "@schoolos/registry";
import { z } from "zod";
import { AiHelpLevel } from "./ai-help.ts";
import { ActivityDefinitionId, ActivityScope, LocalId, OfferingScope } from "./ids.ts";

/**
 * One Content Studio release of a resource: its resource ID and release version. Releases are
 * immutable, so the pair names exact content. Only released resources can be referenced; an item
 * still in review has no release to name.
 */
export const ResourceReleaseRef = z.strictObject({
  resourceId: ResourceId,
  version: ImmutableRelease.shape.version,
});
/** A resource release reference. */
export type ResourceReleaseRef = z.infer<typeof ResourceReleaseRef>;

/** The key a release reference is compared by. */
export const releaseKey = (ref: ResourceReleaseRef): string => `${ref.resourceId}@${ref.version}`;

/**
 * What a student may produce for an activity (roadmap §6.2). The same vocabulary as the Learning
 * Artifacts service (W02), which may move it into `@schoolos/contracts`.
 */
export const ArtifactType = z.enum([
  "document",
  "notebook",
  "spreadsheet",
  "presentation",
  "dataset",
  "image",
  "audio",
  "video",
  "interactive",
  "evidence",
  "portfolio",
  "external-ref",
]);
/** An artifact type. */
export type ArtifactType = z.infer<typeof ArtifactType>;

/** One column of a dataset a step asks for. */
export const DatasetColumn = z.strictObject({
  name: z.string().trim().min(1).max(100),
  unit: z.string().trim().min(1).max(50).optional(),
});
/** A dataset column. */
export type DatasetColumn = z.infer<typeof DatasetColumn>;

/**
 * What a step asks the student to produce. Every kind is subject-neutral: an essay draft, a
 * hypothesis and a sourcing answer are all `writing`, and a lab's data table is a `dataset`.
 */
export const StepResponse = z.discriminatedUnion("kind", [
  /** Read, watch or discuss; nothing is produced. */
  z.strictObject({ kind: z.literal("none") }),
  /** Written work, kept as a `document` artifact. */
  z.strictObject({ kind: z.literal("writing"), minWords: z.int().min(1).max(20_000).optional() }),
  /** A table of observations, kept as a `dataset` artifact. */
  z.strictObject({ kind: z.literal("dataset"), columns: z.array(DatasetColumn).min(1).max(30) }),
  /** Any other artifact, such as a photographed sketch or a recorded performance. */
  z.strictObject({ kind: z.literal("artifact"), artifactType: ArtifactType }),
]);
/** A step response. */
export type StepResponse = z.infer<typeof StepResponse>;

/** The artifact type a step response is kept as, if it produces one. */
export function responseArtifactType(response: StepResponse): ArtifactType | undefined {
  switch (response.kind) {
    case "none":
      return undefined;
    case "writing":
      return "document";
    case "dataset":
      return "dataset";
    case "artifact":
      return response.artifactType;
  }
}

/** One step of an activity's instructions. Its text is the teacher's, never imported content. */
export const ActivityStep = z.strictObject({
  id: LocalId,
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(5000),
  /** Releases the step works from. Each must also be one of the activity's resources. */
  sources: z.array(ResourceReleaseRef).max(50),
  response: StepResponse,
});
/** An activity step. */
export type ActivityStep = z.infer<typeof ActivityStep>;

/** Who may see a Codex entry. `teacher-only` entries are never published to students. */
export const CodexVisibility = z.enum(["students", "teacher-only"]);
/** A Codex visibility. */
export type CodexVisibility = z.infer<typeof CodexVisibility>;

/**
 * One entry of an activity's Codex context: what the class AI helper may draw on. A resource
 * entry names a release; a note is the teacher's own text. An answer key is always teacher-only.
 */
export const CodexEntry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("resource"), resource: ResourceReleaseRef, visibility: CodexVisibility }),
  z
    .strictObject({
      kind: z.literal("note"),
      id: LocalId,
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(20_000),
      purpose: z.enum(["context", "answer-key"]),
      visibility: CodexVisibility,
    })
    .refine((note) => note.purpose !== "answer-key" || note.visibility === "teacher-only", {
      path: ["visibility"],
      message: "an answer key is always teacher-only",
    }),
]);
/** A Codex entry. */
export type CodexEntry = z.infer<typeof CodexEntry>;

/**
 * A rubric release. Rubric content belongs to the assignment and assessment services (E01, E02);
 * an activity only points at one.
 */
export const RubricRef = z.strictObject({ rubricId: RubricId, version: z.int().positive() });
/** A rubric reference. */
export type RubricRef = z.infer<typeof RubricRef>;

/** A place in an activity for a rubric, such as an essay's structure rubric, filled or still empty. */
export const RubricSlot = z.strictObject({
  id: LocalId,
  purpose: z.string().trim().min(1).max(500),
  rubric: RubricRef.optional(),
});
/** A rubric slot. */
export type RubricSlot = z.infer<typeof RubricSlot>;

/**
 * When an activity is due. A definition is reused across terms, so `after-install` counts days
 * from installation; `fixed` names one instant and suits only the term it falls in.
 */
export const DueDateRule = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("fixed"), dueAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ kind: z.literal("after-install"), days: z.int().min(1).max(365) }),
]);
/** A due-date rule. */
export type DueDateRule = z.infer<typeof DueDateRule>;

/** How many citations the work must make, and whether they must come from the activity's resources. */
export const CitationRequirement = z.strictObject({
  minimum: z.int().min(1).max(50),
  from: z.enum(["activity-resources", "any-source"]),
});
/** A citation requirement. */
export type CitationRequirement = z.infer<typeof CitationRequirement>;

/** A competency the activity gathers evidence of, as the teacher names it in the district catalog. */
export const AlignmentRequest = z.strictObject({
  frameworkKey: z.string().min(1).max(100),
  competencyUri: RegistryUri,
});
/** An alignment request. */
export type AlignmentRequest = z.infer<typeof AlignmentRequest>;

/** The evidence an activity gathers, before its alignments are resolved into an evidence contract. */
export const EvidencePlan = z.strictObject({
  responseType: ResponseType,
  criteria: z.array(ObservableCriterion).min(1).max(30),
  collaboration: z.enum(["individual", "group"]),
  alignments: z.array(AlignmentRequest).min(1).max(20),
});
/** An evidence plan. */
export type EvidencePlan = z.infer<typeof EvidencePlan>;

/** The templates that generate activity content. They share the one runtime model below. */
export const TemplateKind = z.enum(["writing-task", "science-investigation", "primary-source-analysis", "problem-set"]);
/** A template kind. */
export type TemplateKind = z.infer<typeof TemplateKind>;

/**
 * Everything a teacher composes in an activity (roadmap §3.2 step 4), whichever template produced
 * it. There is one runtime model for every subject: an essay, a lab and a source investigation
 * differ only in their steps and evidence, never in shape.
 */
export const ActivityContent = z.strictObject({
  /** The template that generated the content. Informational: nothing at run time branches on it. */
  template: TemplateKind,
  title: z.string().trim().min(1).max(200),
  subject: Subject,
  gradeBand: GradeBand,
  overview: z.string().trim().min(1).max(5000),
  steps: z.array(ActivityStep).min(1).max(60),
  /** Every release the activity uses, in the order students meet them. */
  resources: z.array(ResourceReleaseRef).max(50),
  /** The Codex context, in the order the helper and students see it. */
  codex: z.array(CodexEntry).max(100),
  rubricSlots: z.array(RubricSlot).max(10),
  /** The most help the activity allows. It may only narrow the district and offering policy. */
  aiHelp: AiHelpLevel,
  permittedArtifactTypes: z.array(ArtifactType).min(1),
  citations: CitationRequirement.optional(),
  due: DueDateRule,
  evidence: EvidencePlan,
});
/** Activity content. */
export type ActivityContent = z.infer<typeof ActivityContent>;

const duplicates = (ids: string[]) => ids.filter((id, index) => ids.indexOf(id) !== index);

/** A problem in activity content that its shape alone does not rule out. */
export interface ContentIssue {
  path: string;
  message: string;
}

/**
 * The structural rules every activity follows, whichever template produced it. Rules that need
 * other services (releases, alignments, policy) are checked by the curriculum service.
 */
export function checkActivityContent(content: ActivityContent): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const resources = new Set(content.resources.map(releaseKey));
  if (resources.size !== content.resources.length) issues.push({ path: "resources", message: "a release is listed more than once" });
  for (const id of duplicates(content.steps.map((step) => step.id))) issues.push({ path: "steps", message: `step ID ${id} is used more than once` });
  for (const id of duplicates(content.rubricSlots.map((slot) => slot.id))) issues.push({ path: "rubricSlots", message: `rubric slot ${id} is used more than once` });
  const notes = content.codex.flatMap((entry) => (entry.kind === "note" ? [entry.id] : []));
  for (const id of duplicates(notes)) issues.push({ path: "codex", message: `Codex note ${id} is used more than once` });
  for (const [index, step] of content.steps.entries()) {
    const type = responseArtifactType(step.response);
    if (type !== undefined && !content.permittedArtifactTypes.includes(type)) {
      issues.push({ path: `steps.${index}.response`, message: `step ${step.id} asks for a ${type}, which the activity does not permit` });
    }
    for (const source of step.sources) {
      if (!resources.has(releaseKey(source))) issues.push({ path: `steps.${index}.sources`, message: `${releaseKey(source)} is not one of the activity's resources` });
    }
  }
  for (const [index, entry] of content.codex.entries()) {
    if (entry.kind === "resource" && !resources.has(releaseKey(entry.resource))) {
      issues.push({ path: `codex.${index}`, message: `${releaseKey(entry.resource)} is not one of the activity's resources` });
    }
  }
  if (content.citations?.from === "activity-resources" && content.resources.length === 0) {
    issues.push({ path: "citations", message: "citations must come from the activity's resources, but it has none" });
  }
  return issues;
}

/** Where a definition version stands. A published version is immutable. */
export const DefinitionStatus = z.enum(["draft", "published"]);
/** A definition status. */
export type DefinitionStatus = z.infer<typeof DefinitionStatus>;

/**
 * One version of an activity definition: a teacher-approved educational use of resources under
 * instructional rules (roadmap §5.1). Editing a published version creates the next version, so
 * every installation keeps the exact version it pinned.
 */
export const ActivityDefinition = z.strictObject({
  id: ActivityDefinitionId,
  version: z.int().positive(),
  status: DefinitionStatus,
  /** The offering the definition was authored for. Its resources and policy were checked there. */
  scope: OfferingScope,
  content: ActivityContent,
  /** The registry evidence contract, at the same version, with the alignments resolved to pinned framework revisions. */
  evidenceContract: EvidenceContract,
  savedBy: PrincipalId,
  savedAt: z.iso.datetime({ offset: true }),
  published: z.strictObject({ by: PrincipalId, at: z.iso.datetime({ offset: true }) }).optional(),
});
/** An activity definition version. */
export type ActivityDefinition = z.infer<typeof ActivityDefinition>;

/**
 * One definition version installed in one offering and term (roadmap §3.2 step 5). It pins the
 * version, so later edits to the definition never change what students in this class see.
 */
export const ActivityInstallation = z.strictObject({
  id: ActivityId,
  scope: ActivityScope,
  termId: TermId,
  definitionId: ActivityDefinitionId,
  definitionVersion: z.int().positive(),
  /** The definition's AI-help level, checked again against the offering's policy at installation. */
  aiHelp: AiHelpLevel,
  /** The resolved due instant, if the definition has one. */
  dueAt: z.iso.datetime({ offset: true }).optional(),
  installedBy: PrincipalId,
  installedAt: z.iso.datetime({ offset: true }),
  /** Where the student Codex was published. */
  codex: z.strictObject({ collectionKey: z.string().min(1), revision: z.int().positive() }),
});
/** An activity installation. */
export type ActivityInstallation = z.infer<typeof ActivityInstallation>;
