// Extracted from PlayTrek packages/edtech/src/oneroster/client.ts at commit 7258e4347: the OneRoster
// 1.2 REST JSON entity types (GUIDRef, org, academic session, course, class, user, enrollment).
// PlayTrek declared them as TypeScript interfaces and cast responses to them unchecked; here they
// are strict Zod schemas. PlayTrek's user carried the 1.1 single `role` and `orgs` fields, which 1.2
// replaced with `roles`; this follows 1.2.
import { z } from "zod";
import { OneRosterRole, SourcedId } from "../spec.ts";

/**
 * The rostering collections EducateOS reads, in the order a sync fetches them. `demographics` is
 * deliberately absent: EducateOS has no use for it and it is the most sensitive collection a
 * OneRoster server holds, so no code path can request it.
 */
export const ROSTER_COLLECTIONS = ["orgs", "academicSessions", "courses", "classes", "users", "enrollments"] as const;

/** One of {@link ROSTER_COLLECTIONS}. */
export type RosterCollection = (typeof ROSTER_COLLECTIONS)[number];

/** A reference to another record: `{href, sourcedId, type}`. */
const GuidRef = z.strictObject({ href: z.string().max(2048), sourcedId: SourcedId, type: z.string().max(64) });

/** A OneRoster 1.2 timestamp. The specification writes UTC with `Z`; an explicit offset is accepted. */
export const DateTime = z.iso.datetime({ offset: true });

const IsoDate = z.iso.date();
const Strings = z.array(z.string().max(255)).max(1000);

/**
 * The fields every record carries. `metadata` is the specification's extension point; EducateOS
 * never reads it.
 */
const base = {
  sourcedId: SourcedId,
  status: z.enum(["active", "tobedeleted"]),
  dateLastModified: DateTime,
  metadata: z.record(z.string(), z.unknown()).optional(),
};

/**
 * The strict schema of each collection's records. Every field the specification defines is listed,
 * so that a conforming server passes, and any other field is an error. Fields EducateOS does not use,
 * such as `password`, `sms` and `userProfiles`, are validated here and never copied further.
 */
export const RECORD_SCHEMAS = {
  orgs: z.strictObject({
    ...base,
    name: z.string(),
    type: z.enum(["department", "school", "district", "local", "state", "national"]),
    identifier: z.string().optional(),
    parent: GuidRef.optional(),
    children: z.array(GuidRef).optional(),
  }),
  academicSessions: z.strictObject({
    ...base,
    title: z.string(),
    startDate: IsoDate,
    endDate: IsoDate,
    type: z.enum(["gradingPeriod", "semester", "schoolYear", "term"]),
    parent: GuidRef.optional(),
    children: z.array(GuidRef).optional(),
    schoolYear: z.string(),
  }),
  courses: z.strictObject({
    ...base,
    title: z.string(),
    schoolYear: GuidRef.optional(),
    courseCode: z.string().optional(),
    grades: Strings.optional(),
    subjects: Strings.optional(),
    org: GuidRef,
    subjectCodes: Strings.optional(),
    resources: z.array(GuidRef).optional(),
  }),
  classes: z.strictObject({
    ...base,
    title: z.string(),
    classCode: z.string().optional(),
    classType: z.enum(["homeroom", "scheduled"]),
    location: z.string().optional(),
    grades: Strings.optional(),
    subjects: Strings.optional(),
    course: GuidRef,
    school: GuidRef,
    terms: z.array(GuidRef),
    subjectCodes: Strings.optional(),
    periods: Strings.optional(),
    resources: z.array(GuidRef).optional(),
  }),
  users: z.strictObject({
    ...base,
    userMasterIdentifier: z.string().optional(),
    username: z.string(),
    userIds: z.array(z.strictObject({ type: z.string(), identifier: z.string() })).optional(),
    // 1.2 types this as a boolean; servers that kept the 1.1 string form are accepted too.
    enabledUser: z.union([z.boolean(), z.enum(["true", "false"])]),
    givenName: z.string(),
    familyName: z.string(),
    middleName: z.string().optional(),
    preferredFirstName: z.string().optional(),
    preferredMiddleName: z.string().optional(),
    preferredLastName: z.string().optional(),
    pronouns: z.string().optional(),
    roles: z.array(z.strictObject({
      roleType: z.enum(["primary", "secondary"]),
      role: OneRosterRole,
      org: GuidRef,
      userProfile: z.string().optional(),
      beginDate: IsoDate.optional(),
      endDate: IsoDate.optional(),
    })).max(100),
    userProfiles: z.array(z.strictObject({
      profileId: z.string(),
      profileType: z.string(),
      vendorId: z.string(),
      applicationId: z.string().optional(),
      description: z.string().optional(),
      credentials: z.array(z.strictObject({
        type: z.string(),
        username: z.string(),
        password: z.string().optional(),
      })),
    })).optional(),
    primaryOrg: GuidRef.optional(),
    identifier: z.string().optional(),
    email: z.string().optional(),
    sms: z.string().optional(),
    phone: z.string().optional(),
    agents: z.array(GuidRef).optional(),
    grades: Strings.optional(),
    password: z.string().optional(),
    resources: z.array(GuidRef).optional(),
  }),
  enrollments: z.strictObject({
    ...base,
    user: GuidRef,
    class: GuidRef,
    school: GuidRef,
    role: z.enum(["administrator", "proctor", "student", "teacher"]),
    primary: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
    beginDate: IsoDate.optional(),
    endDate: IsoDate.optional(),
  }),
} as const satisfies Record<RosterCollection, z.ZodType>;

/** A validated record of one collection. */
export type RosterRecord<C extends RosterCollection> = z.infer<(typeof RECORD_SCHEMAS)[C]>;

/**
 * A page of a collection: an object holding only the collection's array, such as `{"users": [...]}`.
 * Records are validated one by one afterwards, so one bad record is reported rather than failing
 * the page.
 */
export function pageSchema(collection: RosterCollection) {
  return z.strictObject({ [collection]: z.array(z.unknown()) });
}

/**
 * An OAuth 2.0 access token response (RFC 6749 section 5.1). Not strict: the RFC lets a server add
 * parameters, and the ones beyond these are dropped unread.
 */
export const TokenResponse = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().regex(/^bearer$/i, "must be bearer"),
  expires_in: z.number().int().positive().max(31 * 24 * 3600),
  scope: z.string().optional(),
});
/** A token response. */
export type TokenResponse = z.infer<typeof TokenResponse>;
