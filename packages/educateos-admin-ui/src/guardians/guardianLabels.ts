// How the guardians screen names what the district API identifies by code (ADR-0012).
import type { RouteResponse } from "@educateos/api-client";

/** One relationship row, as the district returns it. */
export type GuardianRow = RouteResponse<"admin.studentGuardians">["relationships"][number];

/** What a relationship can open, in an administrator's words. */
export const READABLE_KIND_LABEL = {
  offering: "Classes",
  activity: "Assignments and due dates",
  feedback: "Feedback released to the student",
  "official-grade": "Official grades",
  announcement: "Class announcements",
} as const satisfies Record<GuardianRow["relationship"]["readableKinds"][number], string>;

/** Every readable kind, in the order the screen lists them. */
export const READABLE_KINDS = Object.keys(READABLE_KIND_LABEL) as (keyof typeof READABLE_KIND_LABEL)[];

/**
 * The reasons a relationship can be suspended. They are stored as codes, never free text, so no
 * family detail is ever written down with the relationship.
 */
export const SUSPEND_REASONS = {
  "court-order-review": "A court order is being reviewed",
  "custody-review": "Custody is being reviewed",
  "student-request": "The student asked for it",
  "district-review": "Another district review",
} as const;

/** A suspension reason code. */
export type SuspendReason = keyof typeof SUSPEND_REASONS;

/** Where a relationship stands, as the screen shows it. */
export type GuardianStanding = "awaiting-sign-in" | "awaiting-confirmation" | "active" | "suspended" | "expired" | "ended";

/** A relationship's standing at `now`. */
export function standingOf(row: GuardianRow, now: Date = new Date()): GuardianStanding {
  const { relationship } = row;
  if (relationship.status === "revoked") return "ended";
  if (relationship.status === "pending") return row.guardianActive ? "awaiting-confirmation" : "awaiting-sign-in";
  if (relationship.suspended !== undefined) return "suspended";
  if (relationship.validUntil !== undefined && Date.parse(relationship.validUntil) <= now.getTime()) return "expired";
  return "active";
}

/** Each standing's label and badge variant. */
export const STANDING = {
  "awaiting-sign-in": { label: "Waiting for the guardian to sign in", variant: "neutral" },
  "awaiting-confirmation": { label: "Waiting for your confirmation", variant: "info" },
  active: { label: "Active", variant: "success" },
  suspended: { label: "Suspended", variant: "warning" },
  expired: { label: "Expired", variant: "neutral" },
  ended: { label: "Ended", variant: "neutral" },
} as const satisfies Record<GuardianStanding, { label: string; variant: string }>;
