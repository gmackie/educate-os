import { ActivityDefinitionId, GradeBand, Subject } from "@educateos/contracts";
import { AlignmentRequest, LocalId, ResourceReleaseRef } from "@educateos/curriculum";
import { LanguageTag, RightsMode } from "@educateos/registry";
import { z } from "zod";
import { SemVer, VersionRange, isExactRange } from "./semver.ts";

/**
 * The OCS format version written for a package that uses no 1.1 feature (RFC 0001 §4, §14). A
 * package moves to 1.1 only when it needs to, so 1.0 readers keep reading everything they can.
 */
export const OCS_SPEC_VERSION = "1.0";

/** The format version that adds portable activities (RFC 0001 §13.1, §14). */
export const OCS_PORTABLE_SPEC_VERSION = "1.1";

/** The format versions this package reads: 1.0, and 1.1, which adds portable activities. */
export const OcsSpecVersion = z.enum([OCS_SPEC_VERSION, OCS_PORTABLE_SPEC_VERSION]);
/** A format version. */
export type OcsSpecVersion = z.infer<typeof OcsSpecVersion>;

/**
 * Identifies an OCS package across all of its versions: the publisher's domain, a slash, and a
 * kebab-case name, such as `northfield.example/biology-core`. The domain keeps two publishers'
 * names apart without a central registry.
 */
export const OcsPackageId = z
  .string()
  .max(200)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\/[a-z][a-z0-9-]{0,62}$/, "expected a package ID such as northfield.example/biology-core");
/** A package identifier. */
export type OcsPackageId = z.infer<typeof OcsPackageId>;

/**
 * Identifies a portable activity (an activity definition export, RFC 0001 §13.1) across all of its
 * versions, in the same publisher-scoped form as a package ID, such as
 * `educateos.io/grade-1-reading-foundations-word-builders`.
 */
export const ActivityExportId = OcsPackageId;
/** An activity export identifier. */
export type ActivityExportId = z.infer<typeof ActivityExportId>;

/** A content digest, `sha256:` and 64 lowercase hex digits, in the form registry releases use. */
export const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 lowercase hex digits>");
/** A content digest. */
export type Sha256Digest = z.infer<typeof Sha256Digest>;

// Markup that runs or loads code when rendered. Package text is plain text and is rendered as such;
// refusing these as well means a renderer that slips cannot be turned into a script host.
const ACTIVE_CONTENT = /<\s*\/?\s*(script|iframe|object|embed|applet|style|link|meta|base|form|svg)\b|\b(javascript|vbscript)\s*:|data\s*:\s*text\/html/i;

/** Whether text holds script or active markup, which no OCS text may (RFC 0001 §9). */
export const hasActiveContent = (text: string): boolean => ACTIVE_CONTENT.test(text);

/** Plain text of at most `max` characters, refusing markup that could run code. */
export const PlainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !ACTIVE_CONTENT.test(text), "package text is plain text and may not contain scripts or active markup");

/** A published curriculum `ActivityDefinition` version of one district (C05): meaningful only there. */
export const DistrictDefinitionRef = z.strictObject({ definitionId: ActivityDefinitionId, version: z.int().positive() });
/** A district-local definition reference. */
export type DistrictDefinitionRef = z.infer<typeof DistrictDefinitionRef>;

/**
 * A published activity definition export (OCS 1.1, RFC 0001 §13.1): its publisher-scoped ID, its
 * exact version and the digest of its content, so the reference names one immutable export.
 */
export const PortableActivityRef = z.strictObject({ id: ActivityExportId, version: SemVer, digest: Sha256Digest });
/** A portable activity reference. */
export type PortableActivityRef = z.infer<typeof PortableActivityRef>;

/** The key a portable reference is mapped and deduplicated by: `id@version`. */
export const portableKey = (ref: Pick<PortableActivityRef, "id" | "version">): string => `${ref.id}@${ref.version}`;

/**
 * What an activity points at: a district-local definition version, `{ definitionId, version }`,
 * valid only inside its own district, or (OCS 1.1) a portable export, `{ portable: { id, version,
 * digest } }`, which any district can import.
 */
export const OcsActivityDefinition = z.union([DistrictDefinitionRef, z.strictObject({ portable: PortableActivityRef })]);
/** An activity's definition reference. */
export type OcsActivityDefinition = z.infer<typeof OcsActivityDefinition>;

/** Whether a definition reference is the portable form. */
export const isPortable = (definition: OcsActivityDefinition): definition is { portable: PortableActivityRef } => "portable" in definition;

/**
 * One activity in a package: a pointer to an activity definition, never the activity's content.
 * The role says how the course uses it.
 */
export const OcsActivity = z.strictObject({
  id: LocalId,
  title: PlainText(200),
  role: z.enum(["lesson", "assignment", "assessment"]),
  definition: OcsActivityDefinition,
});
/** An activity reference. */
export type OcsActivity = z.infer<typeof OcsActivity>;

/**
 * One resource in a package: a Content Studio release and the use the package makes of it, which
 * must be one of the release's permitted uses. A Gadget Blueprint is referenced the same way, by
 * its registry release and the release commit that release names; its files and its blueprint ID
 * (a bearer share link) never appear in a package.
 */
export const OcsResource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("release"),
    id: LocalId,
    title: PlainText(200),
    release: ResourceReleaseRef,
    use: RightsMode,
  }),
  z.strictObject({
    kind: z.literal("gadget-blueprint"),
    id: LocalId,
    title: PlainText(200),
    release: ResourceReleaseRef,
    releaseCommit: z.string().regex(/^[0-9a-f]{40}$/, "expected the blueprint release commit (40 hex digits)"),
    use: RightsMode,
  }),
]);
/** A resource reference. */
export type OcsResource = z.infer<typeof OcsResource>;

/** A Codex note: the teacher's own context for the course AI helper. An answer key is always teacher-only. */
export const OcsCodexNote = z
  .strictObject({
    id: LocalId,
    title: PlainText(200),
    body: PlainText(20_000),
    purpose: z.enum(["context", "answer-key"]),
    visibility: z.enum(["students", "teacher-only"]),
  })
  .refine((note) => note.purpose !== "answer-key" || note.visibility === "teacher-only", {
    path: ["visibility"],
    message: "an answer key is always teacher-only",
  });
/** A Codex note. */
export type OcsCodexNote = z.infer<typeof OcsCodexNote>;

/** One entry in a unit: an activity, resource or Codex note of the same package, by its ID. */
export const OcsUnitItem = z.strictObject({ kind: z.enum(["activity", "resource", "codex"]), ref: LocalId });
/** A unit item. */
export type OcsUnitItem = z.infer<typeof OcsUnitItem>;

/** A unit: an ordered sequence of items taught together. */
export const OcsUnit = z
  .strictObject({
    id: LocalId,
    title: PlainText(200),
    summary: PlainText(5000).optional(),
    standards: z.array(AlignmentRequest).max(50),
    items: z.array(OcsUnitItem).max(200),
  })
  .refine((unit) => new Set(unit.items.map((item) => item.ref)).size === unit.items.length, {
    path: ["items"],
    message: "an item appears in a unit at most once",
  });
/** A unit. */
export type OcsUnit = z.infer<typeof OcsUnit>;

/**
 * A module: another OCS package this one includes, by package ID and version range. A digest pins
 * the exact content and is only meaningful with an exact version. `rights` caps the use of the
 * module's resources in this course: rights only ever narrow on the way up.
 */
export const OcsModule = z
  .strictObject({
    /** The name this package gives the module. Overrides and outline entries use it. */
    name: LocalId,
    package: OcsPackageId,
    range: VersionRange,
    digest: Sha256Digest.optional(),
    rights: RightsMode.optional(),
  })
  .refine((module) => module.digest === undefined || isExactRange(module.range), {
    path: ["digest"],
    message: "a digest pins one version, so the range must be an exact version",
  });
/** A module reference. */
export type OcsModule = z.infer<typeof OcsModule>;

/** One place in the course outline: one of the package's own units, or every unit of a module. */
export const OcsOutlineEntry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unit"), unit: LocalId }),
  z.strictObject({ kind: z.literal("module"), module: LocalId }),
]);
/** An outline entry. */
export type OcsOutlineEntry = z.infer<typeof OcsOutlineEntry>;

/**
 * Where an override applies: the path of module names from this package down to the unit's
 * package, the unit, and optionally one item of it. Overrides only reach into modules; a package
 * edits its own units directly.
 */
export const OcsOverrideTarget = z.strictObject({
  modules: z.array(LocalId).min(1).max(20),
  unit: LocalId,
  item: LocalId.optional(),
});
/** An override target. */
export type OcsOverrideTarget = z.infer<typeof OcsOverrideTarget>;

/**
 * A change this package makes to content it includes from a module, without copying it. A reorder
 * names a module (to reorder its units) or a unit (to reorder its items); the listed IDs come
 * first in the order given and the rest keep their order after them.
 */
export const OcsOverride = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hide"), target: OcsOverrideTarget }),
  z.strictObject({ kind: z.literal("rename"), target: OcsOverrideTarget, title: PlainText(200) }),
  z.strictObject({
    kind: z.literal("reorder"),
    target: z.strictObject({ modules: OcsOverrideTarget.shape.modules, unit: LocalId.optional() }),
    order: z.array(LocalId).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, "an ID is listed more than once"),
  }),
]);
/** An override. */
export type OcsOverride = z.infer<typeof OcsOverride>;

/** The package manifest, `ocs.json`. */
export const OcsManifest = z
  .strictObject({
    /** `"1.0"`, or `"1.1"` for a package with portable activities (RFC 0001 §14). */
    specVersion: OcsSpecVersion,
    id: OcsPackageId,
    version: SemVer,
    title: PlainText(200),
    summary: PlainText(5000).optional(),
    subject: Subject.optional(),
    gradeBand: GradeBand.optional(),
    language: LanguageTag,
    standards: z.array(AlignmentRequest).max(100),
    modules: z.array(OcsModule).max(50),
    outline: z.array(OcsOutlineEntry).max(200),
    overrides: z.array(OcsOverride).max(500),
  })
  .superRefine((manifest, ctx) => {
    const names = manifest.modules.map((module) => module.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", path: ["modules"], message: "a module name is used more than once" });
    const packages = manifest.modules.map((module) => module.package);
    if (new Set(packages).size !== packages.length) ctx.addIssue({ code: "custom", path: ["modules"], message: "a package is included more than once" });
    const keys = manifest.outline.map((entry) => (entry.kind === "unit" ? entry.unit : entry.module));
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["outline"], message: "an outline entry appears more than once, or a unit and a module share a name" });
  });
/** A package manifest. */
export type OcsManifest = z.infer<typeof OcsManifest>;

/** One resolved module edge in a lockfile. */
export const OcsLockedModule = z.strictObject({ name: LocalId, package: OcsPackageId, version: SemVer });
/** A locked module edge. */
export type OcsLockedModule = z.infer<typeof OcsLockedModule>;

/** One package as a lockfile records it: the exact version, its digest and its resolved modules. */
export const OcsLockedPackage = z.strictObject({
  id: OcsPackageId,
  version: SemVer,
  digest: Sha256Digest,
  modules: z.array(OcsLockedModule),
});
/** A locked package. */
export type OcsLockedPackage = z.infer<typeof OcsLockedPackage>;

/**
 * The lockfile, `ocs.lock`: exactly which version and content of every package the course uses.
 * It holds no timestamps or machine details, so the same inputs always produce the same bytes.
 */
export const OcsLock = z.strictObject({
  lockVersion: z.literal(1),
  /** `"1.1"` when the course or any package it includes is 1.1, otherwise `"1.0"`. */
  specVersion: OcsSpecVersion,
  root: OcsLockedPackage,
  /** Every package the course includes, directly or through modules, sorted by ID. */
  packages: z.array(OcsLockedPackage),
});
/** A lockfile. */
export type OcsLock = z.infer<typeof OcsLock>;
