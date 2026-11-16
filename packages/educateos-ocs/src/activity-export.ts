// Portable activities (OCS 1.1, RFC 0001 §13.1): an activity definition export is the data a
// district needs to author the same activity in its own curriculum service, and nothing that only
// means something in the district that wrote it. A course package points at one by publisher-scoped
// ID, version and digest; the destination imports it as a draft definition, which its own teachers
// review and publish, with alignments resolved against its own catalog.
import { canonicalJson, contentDigest } from "@educateos/catalog";
import {
  AlignmentRequest,
  LocalId,
  PictureResponseInput,
  PrimarySourceAnalysisInput,
  ProblemSetInput,
  ReadAndRespondInput,
  type ResourceReleaseRef,
  type RubricRef,
  ScienceInvestigationInput,
  type TemplateInput,
  type TemplateKind,
  WritingTaskInput,
} from "@educateos/curriculum";
import { LanguageTag } from "@educateos/registry";
import { z } from "zod";
import { OcsError, type PackageIssue } from "./errors.ts";
import { ActivityExportId, hasActiveContent, OCS_PORTABLE_SPEC_VERSION, PlainText, type PortableActivityRef, type Sha256Digest } from "./schema.ts";
import { SemVer } from "./semver.ts";

const Text = (max: number) => z.string().trim().min(1).max(max);

/** The ID of a rubric criterion or level: lowercase letters, digits and dashes, as rubric releases use. */
const RubricPartId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "expected lowercase letters, digits and dashes");

/** One performance level of a rubric criterion, worth `points`. */
export const ExportRubricLevel = z.strictObject({
  id: RubricPartId,
  label: PlainText(200),
  points: z.number().nonnegative().max(1000),
});
/** An exported rubric level. */
export type ExportRubricLevel = z.infer<typeof ExportRubricLevel>;

/** One rubric criterion: what is judged, and its levels, lowest first. */
export const ExportRubricCriterion = z.strictObject({
  id: RubricPartId,
  title: PlainText(200),
  description: PlainText(2000).optional(),
  levels: z
    .array(ExportRubricLevel)
    .min(1)
    .max(10)
    .refine((levels) => levels.every((level, i) => i === 0 || level.points > levels[i - 1]!.points), "levels are listed lowest first, each worth more points than the one before")
    .refine((levels) => new Set(levels.map((l) => l.id)).size === levels.length, "level IDs are unique within a criterion"),
});
/** An exported rubric criterion. */
export type ExportRubricCriterion = z.infer<typeof ExportRubricCriterion>;

/**
 * The rubric an export is assessed with, as data: criteria and levels. It carries no evaluator
 * checks (their configuration may hold answer keys) and no AI instructions; the destination signs
 * its own rubric release from it, which fills the template's rubric slot.
 */
export const ExportRubric = z.strictObject({
  title: PlainText(200),
  criteria: z
    .array(ExportRubricCriterion)
    .min(1)
    .max(50)
    .refine((criteria) => new Set(criteria.map((c) => c.id)).size === criteria.length, "criterion IDs are unique within a rubric"),
});
/** An exported rubric. */
export type ExportRubric = z.infer<typeof ExportRubric>;

/**
 * A short text the activity has students read or hear, carried with the export because a Content
 * Studio release is district-local. The destination imports each as a release of its own.
 */
export const ExportReading = z.strictObject({
  id: LocalId,
  title: PlainText(200),
  body: PlainText(20_000),
  /** Who wrote it, or where it is from. Original EducateOS texts say so. */
  attribution: PlainText(500).optional(),
});
/** An exported reading. */
export type ExportReading = z.infer<typeof ExportReading>;

/** When a portable activity is due: never a fixed instant, which only suits one district's term. */
export const PortableDueRule = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("after-install"), days: z.int().min(1).max(365) }),
]);
/** A portable due rule. */
export type PortableDueRule = z.infer<typeof PortableDueRule>;

// Everything district-local in a template's inputs: release references, the Codex (which names
// releases, and whose teacher-only notes belong in the course's teacher-only Codex instead),
// alignments (carried once, by CASE URI, on the export itself) and the fixed due date. Each
// template's rubric reference goes too: the export carries the rubric as data.
const LOCAL = { resources: true, codex: true, alignments: true, due: true } as const;
const portableCommon = {
  /** The export's readings the activity uses, by reading ID, in the order students meet them. */
  resources: z.array(LocalId).max(20).default([]),
  due: PortableDueRule,
};

/** A writing task's inputs, portable. */
export const PortableWritingTask = WritingTaskInput.omit({ ...LOCAL, structureRubric: true }).extend(portableCommon);
/** A science investigation's inputs, portable. */
export const PortableScienceInvestigation = ScienceInvestigationInput.omit({ ...LOCAL, investigationRubric: true }).extend(portableCommon);
/** A primary-source analysis's inputs, portable: its sources are readings of the export, by ID. */
export const PortablePrimarySourceAnalysis = PrimarySourceAnalysisInput.omit({ ...LOCAL, analysisRubric: true }).extend({
  ...portableCommon,
  sources: z.array(LocalId).min(1).max(20),
});
/** A problem set's inputs, portable: prompts only. Answers belong in the course's teacher-only answer key. */
export const PortableProblemSet = ProblemSetInput.omit({ ...LOCAL, solutionRubric: true }).extend({
  ...portableCommon,
  problems: z.array(z.strictObject({ prompt: Text(5000) })).min(1).max(50),
});
/** A picture response's inputs, portable. */
export const PortablePictureResponse = PictureResponseInput.omit({ ...LOCAL, pictureRubric: true }).extend(portableCommon);
/** Read-and-respond inputs, portable. */
export const PortableReadAndRespond = ReadAndRespondInput.omit({ ...LOCAL, responseRubric: true }).extend(portableCommon);

/**
 * A template's inputs in the curriculum's `TemplateInput` vocabulary, minus everything
 * district-local: `resources` and `sources` name the export's readings, there is no `codex`, no
 * `alignments`, no rubric reference, no answers, and `due` is never a fixed instant.
 */
export const PortableTemplateInput = z.discriminatedUnion("template", [
  PortableWritingTask,
  PortableScienceInvestigation,
  PortablePrimarySourceAnalysis,
  PortableProblemSet,
  PortablePictureResponse,
  PortableReadAndRespond,
]);
/** Portable template inputs, as an author writes them. */
export type PortableTemplateInput = z.input<typeof PortableTemplateInput>;

/** Every string in a value, with its JSON path. */
function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (const [index, item] of value.entries()) yield* strings(item, `${path}.${index}`);
  else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) yield* strings(item, path === "" ? key : `${path}.${key}`);
}

/**
 * An activity definition export (OCS 1.1, RFC 0001 §13.1), one JSON file. It is data only, and
 * holds student-facing text only: no scope, principals, answer keys or code, and the same
 * plain-text rule as package text applies to every string in it.
 */
export const ActivityExport = z
  .strictObject({
    specVersion: z.literal(OCS_PORTABLE_SPEC_VERSION),
    /** Publisher-scoped: `<domain>/<name>`, such as `educateos.io/grade-1-reading-foundations-word-builders`. */
    id: ActivityExportId,
    /** Immutable once published: a change is a new version. */
    version: SemVer,
    language: LanguageTag,
    /** The template and its inputs. */
    activity: PortableTemplateInput,
    /** The rubric, as data. */
    rubric: ExportRubric.optional(),
    /** The learning goals, by CASE competency URI, never by a district catalog revision. */
    alignments: z.array(AlignmentRequest).max(20),
    /** Texts the activity has students read or hear. */
    readings: z.array(ExportReading).max(20).default([]),
  })
  .superRefine((exported, ctx) => {
    const readings = exported.readings.map((reading) => reading.id);
    if (new Set(readings).size !== readings.length) ctx.addIssue({ code: "custom", path: ["readings"], message: "a reading ID is used more than once" });
    const known = new Set(readings);
    const named = [
      ...exported.activity.resources.map((id, index) => [["activity", "resources", index], id] as const),
      ...(exported.activity.template === "primary-source-analysis" ? exported.activity.sources.map((id, index) => [["activity", "sources", index], id] as const) : []),
    ];
    for (const [path, id] of named) if (!known.has(id)) ctx.addIssue({ code: "custom", path: [...path], message: `there is no reading ${id}` });
    const goals = exported.alignments.map((a) => `${a.frameworkKey} ${a.competencyUri}`);
    if (new Set(goals).size !== goals.length) ctx.addIssue({ code: "custom", path: ["alignments"], message: "an alignment is listed more than once" });
    for (const [path, text] of strings(exported, "")) {
      if (hasActiveContent(text)) ctx.addIssue({ code: "custom", path: path.split("."), message: "export text is plain text and may not contain scripts or active markup" });
    }
  });
/** An activity definition export, as read. */
export type ActivityExport = z.infer<typeof ActivityExport>;
/** An activity definition export, as an author writes it (defaults may be left out). */
export type ActivityExportInput = z.input<typeof ActivityExport>;

const MAX_EXPORT_BYTES = 256 * 1024;

/** An export read and checked, with its digest. */
export interface ParsedActivityExport {
  export: ActivityExport;
  digest: Sha256Digest;
}

function parseExportJson(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > MAX_EXPORT_BYTES) {
    throw new OcsError({ kind: "invalid-export", issues: [{ path: "", message: `is larger than ${MAX_EXPORT_BYTES} bytes` }] });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OcsError({ kind: "invalid-export", issues: [{ path: "", message: "is not valid JSON" }] });
  }
}

/**
 * The export digest: `sha256:` over the canonical JSON of the file, as package files are digested
 * (RFC 0001 §5.1). Formatting and key order do not change it; any change of content does.
 *
 * @throws OcsError `invalid-export` if the text is not JSON or is too large.
 */
export async function activityExportDigest(text: string): Promise<Sha256Digest> {
  return contentDigest(parseExportJson(text));
}

/**
 * Reads one export file: parses it strictly and computes its digest.
 *
 * @throws OcsError `invalid-export` listing every problem found.
 */
export async function readActivityExport(text: string): Promise<ParsedActivityExport> {
  const json = parseExportJson(text);
  const parsed = ActivityExport.safeParse(json);
  if (!parsed.success) {
    const exportId = typeof (json as { id?: unknown } | null)?.id === "string" ? (json as { id: string }).id : undefined;
    const issues: PackageIssue[] = parsed.error.issues.map((issue) => ({ path: issue.path.join(".") || "export", message: issue.message }));
    throw new OcsError({ kind: "invalid-export", ...(exportId === undefined ? {} : { exportId }), issues });
  }
  return { export: parsed.data, digest: await contentDigest(json) };
}

/**
 * An export's file in the canonical form OCS writes every file in, after checking it. The value is
 * written as given, not with defaults filled in, because the digest covers what the file says.
 *
 * @throws z.ZodError if `exported` is not a valid export.
 */
export function writeActivityExport(exported: ActivityExportInput): string {
  ActivityExport.parse(exported);
  return `${JSON.stringify(JSON.parse(canonicalJson(exported)), null, 2)}\n`;
}

/** The reference that names a parsed export exactly. */
export const exportRef = ({ export: exported, digest }: ParsedActivityExport): PortableActivityRef => ({ id: exported.id, version: exported.version, digest });

const RUBRIC_FIELD: Record<TemplateKind, string> = {
  "writing-task": "structureRubric",
  "science-investigation": "investigationRubric",
  "primary-source-analysis": "analysisRubric",
  "problem-set": "solutionRubric",
  "picture-response": "pictureRubric",
  "read-and-respond": "responseRubric",
};

/** What a destination district supplies to turn an export into its own template inputs. */
export interface ImportBindings {
  /** The district's release of each of the export's readings, by reading ID. */
  readings: ReadonlyMap<string, ResourceReleaseRef>;
  /** The rubric release the district signed from the export's rubric, if any; it fills the template's rubric slot. */
  rubric?: RubricRef | undefined;
  /**
   * The alignments, as the district's own catalog resolves them. Defaults to the export's, which
   * name CASE competency URIs; the curriculum service still checks each against the district's
   * approved frameworks, and refuses a goal it does not hold.
   */
  alignments?: readonly AlignmentRequest[] | undefined;
}

/**
 * The curriculum `TemplateInput` a destination district creates its draft definition from: the
 * export's inputs, with its readings replaced by the district's releases of them (also shared with
 * students in the Codex), its alignments, and its rubric release in the template's rubric slot.
 *
 * @throws OcsError `invalid-export` if a reading the activity uses has no binding.
 */
export function templateInputFor(exported: ActivityExport, bindings: ImportBindings): TemplateInput {
  const release = (id: string): ResourceReleaseRef => {
    const ref = bindings.readings.get(id);
    if (ref === undefined) throw new OcsError({ kind: "invalid-export", exportId: exported.id, issues: [{ path: "readings", message: `the district has no release of reading ${id}` }] });
    return ref;
  };
  const { activity } = exported;
  const sources = activity.template === "primary-source-analysis" ? activity.sources.map(release) : [];
  const resources = activity.resources.map(release);
  const codex = [...resources, ...sources.filter((s) => !resources.some((r) => r.resourceId === s.resourceId && r.version === s.version))]
    .map((resource) => ({ kind: "resource" as const, resource, visibility: "students" as const }));
  const base = {
    ...structuredClone(activity),
    resources,
    codex,
    alignments: [...(bindings.alignments ?? exported.alignments)],
    ...(bindings.rubric === undefined ? {} : { [RUBRIC_FIELD[activity.template]]: bindings.rubric }),
  };
  return (activity.template === "primary-source-analysis" ? { ...base, sources } : base) as TemplateInput;
}

/** One published export version as a source holds it. */
export interface PublishedActivityExport {
  /** The export file, as published. */
  text: string;
  /** The digest recorded at publication. Readers check the text against it. */
  digest: Sha256Digest;
}

/**
 * Where published activity exports come from: the same libraries packages come from (RFC 0001
 * §13.1). Like a package source, it is not trusted: readers check every export's ID, version and
 * digest themselves.
 */
export interface ActivityExportSource {
  /** Every published version of an export, in any order; empty if it is unknown. */
  listExportVersions(id: string): Promise<readonly string[]>;
  /** One published version, or undefined if there is none. */
  getExport(id: string, version: string): Promise<PublishedActivityExport | undefined>;
}
