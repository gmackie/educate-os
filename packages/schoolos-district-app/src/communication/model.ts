// Communication (SCHO-189): the records announcements, weekly notes, notifications, calendar feeds,
// email preferences and the digest send ledger are kept as. Times are UTC throughout.
import { z } from "zod";
import { DistrictId, OfferingId, PrincipalId, SubmissionId } from "@schoolos/contracts";
import { AssignmentId } from "@schoolos/assessment";

const idBody = "[A-Za-z0-9][A-Za-z0-9-]{0,63}";

/** Identifies an announcement. */
export const AnnouncementId = z.string().regex(new RegExp(`^ann_${idBody}$`), "expected an announcement ID (ann_…)");
/** An announcement ID. */
export type AnnouncementId = z.infer<typeof AnnouncementId>;

/** An announcement's title. */
export const AnnouncementTitle = z.string().trim().min(1).max(200);
/** An announcement's body: plain text, shown as written and never interpreted as markup. */
export const AnnouncementText = z.string().trim().min(1).max(10_000);

/** Who did something, and when. */
const Stamp = z.strictObject({ by: PrincipalId, at: z.iso.datetime() });

/**
 * A notice to one offering, posted by its instructors. It is visible to the offering's students
 * (and, through a guardian relationship, their guardians) from `publishAt`; until then it is
 * scheduled and only course staff see it. Deleting one retracts it but keeps the record, so a
 * notification or digest that named it still names something that existed.
 */
export const Announcement = z.strictObject({
  id: AnnouncementId,
  districtId: DistrictId,
  offeringId: OfferingId,
  title: AnnouncementTitle,
  body: AnnouncementText,
  /** When students see it. Equal to `created.at` unless it was scheduled. */
  publishAt: z.iso.datetime(),
  created: Stamp,
  updated: Stamp.optional(),
  deleted: Stamp.optional(),
});
/** An announcement. */
export type Announcement = z.infer<typeof Announcement>;

/** Whether `announcement` is visible to students at `at`: published and not retracted. */
export function announcementPublished(announcement: Announcement, at: Date): boolean {
  return announcement.deleted === undefined && Date.parse(announcement.publishAt) <= at.getTime();
}

/** An ISO 8601 week, `2026-W44`: Monday to Sunday, in UTC. */
export const IsoWeek = z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, "expected an ISO week such as 2026-W44");
/** An ISO week. */
export type IsoWeek = z.infer<typeof IsoWeek>;

/** The ISO week `at` falls in, in UTC. */
export function isoWeekOf(at: Date): IsoWeek {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // The ISO year is the one the week's Thursday falls in.
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The first instant (Monday 00:00 UTC) of an ISO week, and the first instant after it. */
export function isoWeekBounds(week: IsoWeek): { start: Date; end: Date } {
  const [year, number] = week.split("-W").map(Number) as [number, number];
  // January 4th is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const weekday = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const start = new Date(jan4.getTime() + ((number - 1) * 7 - (weekday - 1)) * 86_400_000);
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

/**
 * The week a family digest made at `at` looks ahead to: the week of the following day, so one sent
 * on a Sunday covers the week starting the next morning. Teachers' weekly notes are keyed by it.
 */
export function digestWeekOf(at: Date): IsoWeek {
  return isoWeekOf(new Date(at.getTime() + 86_400_000));
}

/** A teacher's note to families for one offering and week, included in that week's family digest. */
export const WeeklyNote = z.strictObject({
  offeringId: OfferingId,
  week: IsoWeek,
  text: z.string().trim().min(1).max(2_000),
  updated: Stamp,
});
/** A weekly note. */
export type WeeklyNote = z.infer<typeof WeeklyNote>;

/** What a notification is about. */
export const NotificationKind = z.enum(["announcement", "assignment-published", "assignment-due-soon", "feedback-released", "grade-released"]);
/** A notification kind. */
export type NotificationKind = z.infer<typeof NotificationKind>;

/** Identifies a notification. Derived from what it is about, so generating it again finds the same one. */
export const NotificationId = z.string().regex(/^ntf_[0-9a-f]{32}$/, "expected a notification ID (ntf_…)");
/** A notification ID. */
export type NotificationId = z.infer<typeof NotificationId>;

/**
 * An in-app notice to one principal that something in their classes happened. It carries a title
 * and what it points at, never a grade, a score or feedback text: those are read where they live.
 */
export const Notification = z.strictObject({
  id: NotificationId,
  principalId: PrincipalId,
  kind: NotificationKind,
  offeringId: OfferingId,
  title: z.string().min(1).max(300),
  /** What it points at. */
  ref: z.strictObject({
    announcementId: AnnouncementId.optional(),
    assignmentId: AssignmentId.optional(),
    submissionId: SubmissionId.optional(),
  }),
  /** When the thing it is about happened. */
  occurredAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().optional(),
  /** When it was emailed, or why it was not. Absent while it may still be. */
  email: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("sent"), at: z.iso.datetime() }),
    z.strictObject({ status: z.literal("skipped"), at: z.iso.datetime(), reason: z.enum(["opted-out", "no-address", "read", "disabled"]) }),
  ]).optional(),
});
/** A notification. */
export type Notification = z.infer<typeof Notification>;

/** Which emails a principal receives. Every kind is on until they turn it off. */
export const EmailPreferences = z.strictObject({
  announcements: z.boolean(),
  assignments: z.boolean(),
  feedback: z.boolean(),
  grades: z.boolean(),
  /** The weekly family digest, for a guardian. */
  digest: z.boolean(),
});
/** Email preferences. */
export type EmailPreferences = z.infer<typeof EmailPreferences>;

/** The preferences of a principal who has set none. */
export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = { announcements: true, assignments: true, feedback: true, grades: true, digest: true };

/** The preference that governs emailing a notification of `kind`. */
export function preferenceFor(kind: NotificationKind): keyof EmailPreferences {
  switch (kind) {
    case "announcement":
      return "announcements";
    case "assignment-published":
    case "assignment-due-soon":
      return "assignments";
    case "feedback-released":
      return "feedback";
    case "grade-released":
      return "grades";
  }
}

/**
 * A principal's calendar feed. Only the SHA-256 of its 256-bit token is kept: the token itself is
 * shown once, when it is made, and is the whole of the feed's authority. Rotating replaces the
 * hash; revoking removes it. Either way the old URL answers 404.
 */
export const CalendarFeed = z.strictObject({
  principalId: PrincipalId,
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
});
/** A calendar feed. */
export type CalendarFeed = z.infer<typeof CalendarFeed>;

/** Where one guardian's digest for one week is. A week is sent at most once. */
export const DigestLedgerEntry = z.strictObject({
  guardianPrincipalId: PrincipalId,
  week: IsoWeek,
  /**
   * - `sending`: claimed; a send may or may not have happened, so it is never retried.
   * - `sent`: delivered to the mail provider.
   * - `skipped`: deliberately not sent (no address, opted out, nothing to say).
   * - `failed`: the provider refused it; the next run tries again.
   */
  status: z.enum(["sending", "sent", "skipped", "failed"]),
  reason: z.enum(["no-address", "opted-out", "empty", "disabled", "provider-error"]).optional(),
  at: z.iso.datetime(),
});
/** A digest ledger entry. */
export type DigestLedgerEntry = z.infer<typeof DigestLedgerEntry>;
