import { z } from "zod";

/**
 * Every SchoolOS identifier is `<prefix>_<body>`, where the prefix names the entity kind. A value
 * of one kind therefore never parses as another, so passing a school ID where an offering ID was
 * expected fails validation instead of matching some unrelated record.
 *
 * IDs are opaque and district-local. Nothing derives them from an email, a name or an external
 * system's identifier; those are recorded as attributes and links (see `identity.ts`).
 */
export const ID_PREFIXES = {
  district: "dst",
  school: "sch",
  term: "trm",
  course: "crs",
  offering: "off",
  enrollment: "enr",
  principal: "prn",
  workspace: "wsp",
  activity: "act",
  artifact: "art",
  submission: "sub",
  rubric: "rbr",
  assessmentRun: "asr",
  configRevision: "cfg",
  revision: "rev",
  activityDefinition: "adf",
  contentItem: "cit",
  resource: "rsc",
  curriculumPack: "pck",
  learningUnit: "unt",
  evidenceContract: "evc",
  instance: "ins",
} as const;

/** The entity kinds that have their own identifier type. */
export type IdKind = keyof typeof ID_PREFIXES;

const ID_BODY = "[a-z0-9][a-z0-9-]{0,62}";

function idSchema<K extends IdKind>(kind: K) {
  return z
    .string()
    .regex(new RegExp(`^${ID_PREFIXES[kind]}_${ID_BODY}$`), `expected a ${kind} ID (${ID_PREFIXES[kind]}_…)`)
    .brand<K>();
}

/** Identifies a district: the tenant boundary. Every other ID is scoped under exactly one. */
export const DistrictId = idSchema("district");
/** A district identifier. */
export type DistrictId = z.infer<typeof DistrictId>;

/** Identifies a school within a district. */
export const SchoolId = idSchema("school");
/** A school identifier. */
export type SchoolId = z.infer<typeof SchoolId>;

/** Identifies an academic term (a semester, trimester or year) within a district. */
export const TermId = idSchema("term");
/** An academic term identifier. */
export type TermId = z.infer<typeof TermId>;

/** Identifies a catalog course: the reusable definition, such as Biology I. */
export const CourseId = idSchema("course");
/** A catalog course identifier. */
export type CourseId = z.infer<typeof CourseId>;

/** Identifies a course offering: one section of a catalog course, in one school and term. */
export const OfferingId = idSchema("offering");
/** A course offering identifier. */
export type OfferingId = z.infer<typeof OfferingId>;

/** Identifies one principal's enrollment in one offering. */
export const EnrollmentId = idSchema("enrollment");
/** An enrollment identifier. */
export type EnrollmentId = z.infer<typeof EnrollmentId>;

/** Identifies a principal: a person or service that can be authenticated and authorized. */
export const PrincipalId = idSchema("principal");
/** A principal identifier. */
export type PrincipalId = z.infer<typeof PrincipalId>;

/** Identifies a personal or course workspace. */
export const WorkspaceId = idSchema("workspace");
/** A workspace identifier. */
export type WorkspaceId = z.infer<typeof WorkspaceId>;

/** Identifies an activity installed in an offering. */
export const ActivityId = idSchema("activity");
/** An activity identifier. */
export type ActivityId = z.infer<typeof ActivityId>;

/** Identifies a learning artifact. Its revisions are content-addressed separately. */
export const ArtifactId = idSchema("artifact");
/** A learning artifact identifier. */
export type ArtifactId = z.infer<typeof ArtifactId>;

/** Identifies an immutable submission snapshot. */
export const SubmissionId = idSchema("submission");
/** A submission identifier. */
export type SubmissionId = z.infer<typeof SubmissionId>;

/** Identifies a rubric release. */
export const RubricId = idSchema("rubric");
/** A rubric identifier. */
export type RubricId = z.infer<typeof RubricId>;

/** Identifies one assessment run of one submission against one rubric and evaluator release. */
export const AssessmentRunId = idSchema("assessmentRun");
/** An assessment run identifier. */
export type AssessmentRunId = z.infer<typeof AssessmentRunId>;

/**
 * Identifies a capability pack. It is a plain kebab-case name (`core-learning`, `assessment-ci`)
 * rather than a prefixed ID, because pack IDs are published names shared by every district, not
 * district-local records.
 */
export const CapabilityId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "expected a kebab-case capability ID")
  .brand<"capability">();
/** A capability pack identifier. */
export type CapabilityId = z.infer<typeof CapabilityId>;

/** Identifies one configuration revision. */
export const ConfigRevisionId = idSchema("configRevision");
/** A configuration revision identifier. */
export type ConfigRevisionId = z.infer<typeof ConfigRevisionId>;

/**
 * Identifies one immutable revision of a learning artifact. A submission snapshot and a receipt
 * name the revision they cover, so a later save cannot change what was submitted.
 */
export const RevisionId = idSchema("revision");
/** A revision identifier. */
export type RevisionId = z.infer<typeof RevisionId>;

/**
 * Identifies an activity definition, across all of its versions. An installed activity is
 * identified separately, by {@link ActivityId}.
 */
export const ActivityDefinitionId = idSchema("activityDefinition");
/** An activity definition identifier. */
export type ActivityDefinitionId = z.infer<typeof ActivityDefinitionId>;

/** Identifies one content item: one imported revision of a source as it moves through ingest. */
export const ContentItemId = idSchema("contentItem");
/** A content item identifier. */
export type ContentItemId = z.infer<typeof ContentItemId>;

/** Identifies a resource in the learning resource registry. Each of its releases is versioned separately. */
export const ResourceId = idSchema("resource");
/** A resource identifier. */
export type ResourceId = z.infer<typeof ResourceId>;

/** Identifies a curriculum pack in the registry. */
export const CurriculumPackId = idSchema("curriculumPack");
/** A curriculum pack identifier. */
export type CurriculumPackId = z.infer<typeof CurriculumPackId>;

/** Identifies a learning unit in the registry. */
export const LearningUnitId = idSchema("learningUnit");
/** A learning unit identifier. */
export type LearningUnitId = z.infer<typeof LearningUnitId>;

/** Identifies an evidence contract in the registry. Each of its versions is numbered separately. */
export const EvidenceContractId = idSchema("evidenceContract");
/** An evidence contract identifier. */
export type EvidenceContractId = z.infer<typeof EvidenceContractId>;

/**
 * Identifies one SchoolOS deployment in the root's fleet registry. The district chooses it, and it
 * is opaque to the root: nothing derives it from a person, and it is distinct from the district's
 * own {@link DistrictId}, so the root never learns district-local identifiers.
 */
export const InstanceId = idSchema("instance");
/** An instance identifier. */
export type InstanceId = z.infer<typeof InstanceId>;
