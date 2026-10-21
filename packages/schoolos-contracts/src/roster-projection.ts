import { z } from "zod";
import { DistrictId, OfferingId } from "./ids.ts";
import { ExternalIdentity } from "./identity.ts";
import { UtcTimestamp } from "./primitives.ts";

/**
 * Whether an external platform lists a member as active. A `deleted` member is reported so a sync
 * adapter can end their live access; it is never a reason to delete a principal, an enrollment or
 * work.
 */
export const ProjectedMemberStatus = z.enum(["active", "inactive", "deleted"]);
/** A projected member's status. */
export type ProjectedMemberStatus = z.infer<typeof ProjectedMemberStatus>;

/**
 * One member of an external roster, as the external system reports them.
 *
 * `identity` is the only way to find the person in the district: a sync adapter looks up the
 * principal linked to `(district, issuer, subject)` and skips members with no link. Roles are kept
 * as untrusted metadata under a name that says so: a platform calling someone an instructor or an
 * administrator grants them nothing. The adapter decides enrollment roles from the district's own
 * roster source or its own mapping, never from this field alone.
 */
export const RosterProjectionMember = z.strictObject({
  identity: ExternalIdentity,
  status: ProjectedMemberStatus,
  /** The external system's role strings, verbatim. Not an authorization input. */
  untrustedPlatformRoles: z.array(z.string().max(512)).max(64),
});
/** A projected roster member. */
export type RosterProjectionMember = z.infer<typeof RosterProjectionMember>;

/** Where a projection came from. */
export const RosterProjectionSource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("lti-nrps"),
    issuer: z.url({ protocol: /^https$/ }),
    clientId: z.string().min(1).max(255),
    contextId: z.string().min(1).max(255),
  }),
  z.strictObject({ kind: z.literal("google-classroom"), courseId: z.string().min(1).max(255) }),
]);
/** A projection source. */
export type RosterProjectionSource = z.infer<typeof RosterProjectionSource>;

/**
 * An external roster for one offering, as observed at `observedAt`. It is input for a sync
 * adapter, not a directory write. The adapter that consumes it (through `@schoolos/academics`'
 * `AcademicSync`, only when the district's authority map names this provider for enrollments) adds
 * or updates enrollments and marks missing or deleted members inactive; it never removes a record
 * (roadmap §6.3, §14).
 */
export const RosterProjection = z.strictObject({
  districtId: DistrictId,
  offeringId: OfferingId,
  source: RosterProjectionSource,
  observedAt: UtcTimestamp,
  members: z.array(RosterProjectionMember),
});
/** A roster projection. */
export type RosterProjection = z.infer<typeof RosterProjection>;
