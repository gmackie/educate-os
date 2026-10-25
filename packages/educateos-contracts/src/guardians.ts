import { z } from "zod";
import { DistrictId, GuardianRelationshipId, OfferingId, PrincipalId } from "./ids.ts";
import { OpaqueCode, UtcTimestamp } from "./primitives.ts";
import type { ResourceKind } from "./authorization.ts";

/**
 * The resource kinds a guardian may ever read about their child (ADR-0012): the child's offerings,
 * the assignments installed in them (with their due dates), the feedback released to the child,
 * the child's official grades, and the offerings' announcements. Everything else (personal
 * workspaces, conversations, the child's working artifacts and submissions, rosters, other
 * children) is outside this list and so out of reach, whatever a relationship says.
 */
export const GUARDIAN_READABLE_KINDS = [
  "offering",
  "activity",
  "feedback",
  "official-grade",
  "announcement",
] as const satisfies readonly ResourceKind[];

/** One of the {@link GUARDIAN_READABLE_KINDS}. */
export const GuardianReadableKind = z.enum(GUARDIAN_READABLE_KINDS);
/** A resource kind a guardian may read. */
export type GuardianReadableKind = z.infer<typeof GuardianReadableKind>;

/**
 * Where a guardian relationship is in its life.
 *
 * - `pending`: recorded (for example from an invitation) but not yet confirmed by a district
 *   administrator. It grants nothing.
 * - `active`: confirmed. It grants reads while its dates, consent and suspension allow.
 * - `revoked`: ended. It grants nothing, is never reactivated, and is kept for the record.
 */
export const GuardianRelationshipStatus = z.enum(["pending", "active", "revoked"]);
/** A guardian relationship status. */
export type GuardianRelationshipStatus = z.infer<typeof GuardianRelationshipStatus>;

/**
 * Whether the student's consent governs the relationship. A minor's guardian needs none
 * (`not-required`). Once the student's rights transfer to them (for example FERPA's eligible
 * student), the district records whether the student `granted` it; `withdrawn` stops every read.
 */
export const GuardianConsent = z.enum(["not-required", "granted", "withdrawn"]);
/** A guardian consent state. */
export type GuardianConsent = z.infer<typeof GuardianConsent>;

/** Who did something to a relationship, and when. */
const Stamp = z.strictObject({ by: PrincipalId, at: UtcTimestamp });

/**
 * The record that lets one guardian read one student's course records (ADR-0012). It is the only
 * source of a guardian's authority: never a roster, a token claim or the guardian's own assertion.
 * A district administrator creates and confirms it; the policy engine reads it through a
 * relationship source and audits every read it allows under its `id`.
 *
 * It is read-only in v1: no relationship lets a guardian change, submit or share anything.
 */
export const GuardianRelationship = z.strictObject({
  /** The relationship's ID, recorded in the audit entry of every read it allows. */
  id: GuardianRelationshipId,
  /** The district. The guardian and the student are both its principals. */
  districtId: DistrictId,
  /** The guardian: a principal of kind `guardian`. */
  guardianPrincipalId: PrincipalId,
  /** The one student it concerns: a principal of kind `student`. Each child needs its own record. */
  studentPrincipalId: PrincipalId,
  /** Where the relationship is in its life. Only `active` grants anything. */
  status: GuardianRelationshipStatus,
  /**
   * Narrows the relationship to these of the student's offerings. Absent, it covers every offering
   * the student is actively enrolled in, and the student's own records in any offering.
   */
  offeringIds: z.array(OfferingId).min(1).max(100).optional(),
  /**
   * The kinds of record it opens, a subset of {@link GUARDIAN_READABLE_KINDS}. A district narrows
   * this to honour a restriction, such as withholding grades from one guardian.
   */
  readableKinds: z.array(GuardianReadableKind).min(1),
  /** Whether the student's consent governs the relationship, and if so whether it is given. */
  consent: GuardianConsent,
  /**
   * Set while access is suspended without ending the relationship, such as under a court order
   * being reviewed. The reason is an opaque code, never free text, so no family detail reaches
   * the record.
   */
  suspended: z.strictObject({ by: PrincipalId, at: UtcTimestamp, reason: OpaqueCode }).optional(),
  /** When it starts to grant reads. */
  validFrom: UtcTimestamp,
  /** When it stops granting reads (exclusive). Absent, until revoked. */
  validUntil: UtcTimestamp.optional(),
  /** The administrator who recorded it, and when. */
  created: Stamp,
  /** The district administrator who confirmed it, and when. Present exactly when it was ever `active`. */
  confirmed: Stamp.optional(),
  /** Who revoked it, and when. Present exactly when it is `revoked`. */
  revoked: Stamp.optional(),
}).superRefine((relationship, ctx) => {
  if (relationship.guardianPrincipalId === relationship.studentPrincipalId) {
    ctx.addIssue({ code: "custom", path: ["guardianPrincipalId"], message: "a principal cannot be their own guardian" });
  }
  if (relationship.validUntil !== undefined && Date.parse(relationship.validUntil) <= Date.parse(relationship.validFrom)) {
    ctx.addIssue({ code: "custom", path: ["validUntil"], message: "validUntil must be after validFrom" });
  }
  if (relationship.status === "active" && relationship.confirmed === undefined) {
    ctx.addIssue({ code: "custom", path: ["confirmed"], message: "an active relationship must record its confirmation" });
  }
  if (relationship.status === "pending" && relationship.confirmed !== undefined) {
    ctx.addIssue({ code: "custom", path: ["confirmed"], message: "a pending relationship has not been confirmed" });
  }
  if ((relationship.status === "revoked") !== (relationship.revoked !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["revoked"], message: "revoked is recorded exactly when the status is revoked" });
  }
  if (new Set(relationship.readableKinds).size !== relationship.readableKinds.length) {
    ctx.addIssue({ code: "custom", path: ["readableKinds"], message: "readableKinds lists a kind twice" });
  }
});
/** A guardian relationship. */
export type GuardianRelationship = z.infer<typeof GuardianRelationship>;

/**
 * Whether `relationship` grants reads at `at`: `active`, within its dates, not suspended, and not
 * awaiting or refused the student's consent. Who the guardian and student are, and whether they
 * are still active principals, is the relationship source's to check.
 */
export function guardianRelationshipInForce(relationship: GuardianRelationship, at: Date): boolean {
  const time = at.getTime();
  return relationship.status === "active"
    && relationship.suspended === undefined
    && relationship.consent !== "withdrawn"
    && Date.parse(relationship.validFrom) <= time
    && (relationship.validUntil === undefined || time < Date.parse(relationship.validUntil));
}
