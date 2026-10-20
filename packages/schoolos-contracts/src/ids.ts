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
