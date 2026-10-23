// Communication (SCHO-189): announcements, teachers' weekly notes, a principal's calendar and its
// iCalendar feed, in-app notifications and their emails, and email preferences. Every read and
// write is decided by the district's one policy engine; this service records and filters, and
// derives nothing a principal could not already read.
import {
  SchoolOsError,
  type Action,
  type Caller,
  type Classification,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type OfferingId,
  type PrincipalId,
  type ResourceRef,
  type VerifiedPrincipal,
} from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";
import type { AssessmentService, AssignmentBinding, AssignmentId, SubmissionSnapshot } from "@schoolos/assessment";
import type { PolicyDecider } from "@schoolos/policy";
import { renderIcs } from "./ics.ts";
import { isDeliverableAddress, type MailSender } from "./mail.ts";
import {
  announcementPublished,
  DEFAULT_EMAIL_PREFERENCES,
  EmailPreferences,
  preferenceFor,
  type Announcement,
  type AnnouncementId,
  type IsoWeek,
  type Notification,
  type NotificationId,
  type NotificationKind,
  type WeeklyNote,
} from "./model.ts";
import { byPublishAt, type CommunicationStores } from "./stores.ts";

/** The reads of the assessment service a principal's view is built from, each authorized for its caller. */
export type AssessmentReader = Pick<AssessmentService, "listAssignments" | "listSubmissions" | "getFeedback" | "officialGrades">;

/** What a {@link CommunicationService} is built from. */
export interface CommunicationServiceOptions {
  districtId: DistrictId;
  stores: CommunicationStores;
  directory: AcademicStore;
  /** The district's policy engine, auditing under the operation's correlation ID. */
  decider: PolicyDecider;
  /** The assessment service, deciding through the same engine. */
  assessment: AssessmentReader;
  /** Where email goes. Without one, nothing is emailed. */
  mail?: MailSender;
  /** The district's SchoolOS address, linked from emails. */
  appUrl?: string;
  now: () => Date;
}

/** An announcement with the course it was posted to. */
export interface AnnouncementView {
  announcement: Announcement;
  courseLabel: string;
  /** Whether students can see it yet. */
  published: boolean;
}

/** One event on a principal's calendar. */
export interface CalendarEvent {
  /** Stable across reads and feed refreshes. */
  uid: string;
  kind: "assignment-due" | "announcement" | "term-start" | "term-end";
  title: string;
  /** A UTC timestamp, or a `YYYY-MM-DD` date when `allDay`. */
  start: string;
  allDay: boolean;
  offeringId?: OfferingId;
  assignmentId?: AssignmentId;
  announcementId?: AnnouncementId;
}

/** What one student sees of one of their classes: the basis of notifications and family digests. */
export interface StudentOfferingView {
  offeringId: OfferingId;
  courseLabel: string;
  assignments: AssignmentBinding[];
  /** Published, not retracted. */
  announcements: Announcement[];
  /** Feedback released to the student, by submission. Only that it was released, never its content. */
  releasedFeedback: { submission: SubmissionSnapshot; assignment: AssignmentBinding; releasedAt: string }[];
  /** Official grade versions, without their scores. */
  grades: { assignment: AssignmentBinding; version: number; approvedAt: string }[];
  /** Whether the student has live (not withdrawn) work submitted, by assignment. */
  submitted: ReadonlySet<AssignmentId>;
}

/** The newest notifications a principal sees. */
const NOTIFICATION_PAGE = 100;
/** How far back a new notification may reach, so a first sweep does not replay a term. */
const NOTIFY_WINDOW_MS = 14 * 86_400_000;
/** How close a due date is before it earns a reminder. */
const DUE_SOON_MS = 48 * 3_600_000;
/** Notification emails sent per run, so one run stays bounded. */
const EMAILS_PER_RUN = 200;
/** The widest calendar range one read may ask for. */
export const MAX_CALENDAR_RANGE_DAYS = 400;

/** A course offering's label: its course title and section. */
export function courseLabelOf(snapshot: DistrictDirectorySnapshot, offeringId: OfferingId): string {
  const offering = snapshot.offerings.find((o) => o.id === offeringId);
  const course = snapshot.courses.find((c) => c.id === offering?.courseId);
  return course === undefined ? "Class" : `${course.title} (${offering!.sectionName})`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A notification's ID: the same principal, kind and subject always derive the same one. */
export async function notificationIdFor(principalId: PrincipalId, kind: NotificationKind, key: string): Promise<NotificationId> {
  return `ntf_${(await sha256Hex(`${principalId}\n${kind}\n${key}`)).slice(0, 32)}`;
}

/** A calendar feed token: 256 random bits, base64url without padding (43 characters). */
export function newFeedToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What a feed token is kept as. */
export const feedTokenHash = (token: string): Promise<string> => sha256Hex(token);

/** Whether a string has the shape of a feed token. */
export const isFeedToken = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(value);

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Whether `error` is the `not-found` a service answers for what the caller may not see. */
const isNotFound = (error: unknown) => error instanceof SchoolOsError && error.code === "not-found";

/** What `promise` resolves to, or `undefined` if it answers `not-found`. Every other failure is thrown. */
async function unlessNotFound<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Announcements, weekly notes, calendars, notifications and preferences for one district. */
export class CommunicationService {
  readonly #options: CommunicationServiceOptions;

  constructor(options: CommunicationServiceOptions) {
    this.#options = options;
  }

  get #stores() {
    return this.#options.stores;
  }

  async #snapshot(): Promise<DistrictDirectorySnapshot> {
    return (await this.#options.directory.load()).snapshot;
  }

  /** The policy resource for an offering's announcements (or one of them). */
  #announcementRef(snapshot: DistrictDirectorySnapshot, offeringId: OfferingId, classification: Classification, id?: string): ResourceRef {
    const offering = snapshot.offerings.find((o) => o.id === offeringId);
    if (offering === undefined) throw new SchoolOsError("not-found", `offering ${offeringId} was not found.`);
    return {
      kind: "announcement",
      ...(id === undefined ? {} : { id }),
      scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId },
      classification,
    };
  }

  async #allows(caller: Caller, snapshot: DistrictDirectorySnapshot, action: Action, resource: ResourceRef): Promise<boolean> {
    const scope = resource.scope;
    const offering = scope.level === "offering" ? snapshot.offerings.find((o) => o.id === scope.offeringId) : undefined;
    const term = snapshot.terms.find((t) => t.id === offering?.termId);
    const { decision } = await this.#options.decider.decide(
      { subject: caller.principal, action, resource, context: { channel: caller.channel, ...(term === undefined ? {} : { termState: term.state }) } },
      caller.correlationId === undefined ? {} : { correlationId: caller.correlationId },
    );
    return decision.effect === "allow";
  }

  /**
   * Which view of an offering's announcements the caller has: staff (course staff and
   * administrators over it) see scheduled ones too, which are `teacher-only` until published;
   * students see the published ones. Anyone else is answered `not-found`.
   */
  async #view(caller: Caller, snapshot: DistrictDirectorySnapshot, offeringId: OfferingId): Promise<"staff" | "student"> {
    if (await this.#allows(caller, snapshot, "list", this.#announcementRef(snapshot, offeringId, "teacher-only"))) return "staff";
    if (await this.#allows(caller, snapshot, "list", this.#announcementRef(snapshot, offeringId, "course"))) return "student";
    throw new SchoolOsError("not-found", `offering ${offeringId} was not found.`);
  }

  /** Requires the caller to be allowed `action` on the offering's announcements, answering `forbidden` if they can only read them. */
  async #requireManage(caller: Caller, snapshot: DistrictDirectorySnapshot, offeringId: OfferingId, action: "create" | "update", id?: string) {
    await this.#view(caller, snapshot, offeringId);
    if (!(await this.#allows(caller, snapshot, action, this.#announcementRef(snapshot, offeringId, "course", id)))) {
      throw new SchoolOsError("forbidden", "Only the class's teachers can post or change its announcements.");
    }
  }

  // Announcements

  /** An offering's announcements as the caller may see them, newest first. */
  async listAnnouncements(caller: Caller, offeringId: OfferingId): Promise<{ view: "staff" | "student"; announcements: AnnouncementView[] }> {
    const snapshot = await this.#snapshot();
    const view = await this.#view(caller, snapshot, offeringId);
    const at = this.#options.now();
    const courseLabel = courseLabelOf(snapshot, offeringId);
    const announcements = (await this.#stores.announcements.list(offeringId))
      .filter((a) => a.deleted === undefined && (view === "staff" || announcementPublished(a, at)))
      .toSorted((a, b) => -byPublishAt(a, b))
      .map((announcement) => ({ announcement, courseLabel, published: announcementPublished(announcement, at) }));
    return { view, announcements };
  }

  /** The published announcements of every class the caller is actively enrolled in as a student, newest first. */
  async studentAnnouncements(caller: Caller): Promise<AnnouncementView[]> {
    const snapshot = await this.#snapshot();
    const offerings = activeOfferings(snapshot, caller.principal.principalId, "student");
    const all: AnnouncementView[] = [];
    for (const offeringId of offerings) {
      const listed = await unlessNotFound(this.listAnnouncements(caller, offeringId));
      for (const view of listed?.announcements ?? []) if (view.published) all.push(view);
    }
    return all.toSorted((a, b) => -byPublishAt(a.announcement, b.announcement));
  }

  /**
   * Posts an announcement to an offering, published now or at `publishAt` if that is later. Only
   * the offering's instructors may, and not in a completed term.
   */
  async createAnnouncement(caller: Caller, offeringId: OfferingId, input: { title: string; body: string; publishAt?: string | undefined }): Promise<AnnouncementView> {
    const snapshot = await this.#snapshot();
    await this.#requireManage(caller, snapshot, offeringId, "create");
    const now = this.#options.now();
    const stamp = { by: caller.principal.principalId, at: now.toISOString() };
    const announcement: Announcement = {
      id: `ann_${crypto.randomUUID()}`,
      districtId: this.#options.districtId,
      offeringId,
      title: input.title,
      body: input.body,
      publishAt: laterOf(input.publishAt, now),
      created: stamp,
    };
    await this.#stores.announcements.put(announcement);
    return { announcement, courseLabel: courseLabelOf(snapshot, offeringId), published: announcementPublished(announcement, now) };
  }

  /** Changes an announcement's text, or reschedules one not yet published. */
  async updateAnnouncement(caller: Caller, id: AnnouncementId, patch: { title?: string | undefined; body?: string | undefined; publishAt?: string | undefined }): Promise<AnnouncementView> {
    const { snapshot, announcement } = await this.#managed(caller, id);
    const now = this.#options.now();
    if (patch.publishAt !== undefined && announcementPublished(announcement, now)) {
      throw new SchoolOsError("conflict", "This announcement is already published; post a new one instead of rescheduling it.");
    }
    const updated: Announcement = {
      ...announcement,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.body === undefined ? {} : { body: patch.body }),
      ...(patch.publishAt === undefined ? {} : { publishAt: laterOf(patch.publishAt, now) }),
      updated: { by: caller.principal.principalId, at: now.toISOString() },
    };
    await this.#stores.announcements.put(updated);
    return { announcement: updated, courseLabel: courseLabelOf(snapshot, updated.offeringId), published: announcementPublished(updated, now) };
  }

  /**
   * Retracts an announcement: nobody sees it any more, but the record is kept. Policy decides it as
   * an `update`, since nothing is erased. Retracting it again changes nothing.
   */
  async deleteAnnouncement(caller: Caller, id: AnnouncementId): Promise<{ deleted: true }> {
    const { announcement } = await this.#managed(caller, id);
    if (announcement.deleted === undefined) {
      await this.#stores.announcements.put({ ...announcement, deleted: { by: caller.principal.principalId, at: this.#options.now().toISOString() } });
    }
    return { deleted: true };
  }

  async #managed(caller: Caller, id: AnnouncementId) {
    const snapshot = await this.#snapshot();
    const announcement = await this.#stores.announcements.get(id);
    if (announcement === undefined || announcement.districtId !== this.#options.districtId) {
      throw new SchoolOsError("not-found", `announcement ${id} was not found.`);
    }
    // Someone who cannot see the offering's announcements learns nothing about this one.
    if ((await unlessNotFound(this.#requireManage(caller, snapshot, announcement.offeringId, "update", announcement.id).then(() => true))) === undefined) {
      throw new SchoolOsError("not-found", `announcement ${id} was not found.`);
    }
    return { snapshot, announcement };
  }

  // Weekly notes

  /** An offering's weekly note to families, to its staff. */
  async weeklyNote(caller: Caller, offeringId: OfferingId, week: IsoWeek): Promise<WeeklyNote | null> {
    const snapshot = await this.#snapshot();
    if ((await this.#view(caller, snapshot, offeringId)) !== "staff") throw new SchoolOsError("forbidden", "Only the class's staff read its notes to families.");
    return (await this.#stores.weeklyNotes.get(offeringId, week)) ?? null;
  }

  /** Sets, or with empty text clears, an offering's weekly note to families. Its instructors only. */
  async setWeeklyNote(caller: Caller, offeringId: OfferingId, week: IsoWeek, text: string): Promise<WeeklyNote | null> {
    const snapshot = await this.#snapshot();
    await this.#requireManage(caller, snapshot, offeringId, "update");
    if (text.trim() === "") {
      await this.#stores.weeklyNotes.delete(offeringId, week);
      return null;
    }
    const note: WeeklyNote = { offeringId, week, text: text.trim(), updated: { by: caller.principal.principalId, at: this.#options.now().toISOString() } };
    await this.#stores.weeklyNotes.put(note);
    return note;
  }

  /** The note families of an offering get for a week, without who wrote it. For the digest only. */
  async noteForDigest(offeringId: OfferingId, week: IsoWeek): Promise<string | undefined> {
    return (await this.#stores.weeklyNotes.get(offeringId, week))?.text;
  }

  // A student's view

  /**
   * What `caller`, a student, sees of their active classes: each read made as them, through the
   * services that decide it, so nothing unreleased or not theirs can appear. `offeringIds` narrows
   * it to some of them.
   */
  async studentView(caller: Caller, offeringIds?: readonly OfferingId[]): Promise<StudentOfferingView[]> {
    const snapshot = await this.#snapshot();
    const { assessment } = this.#options;
    const studentId = caller.principal.principalId;
    const views: StudentOfferingView[] = [];
    for (const offeringId of activeOfferings(snapshot, studentId, "student")) {
      if (offeringIds !== undefined && !offeringIds.includes(offeringId)) continue;
      const assignments = await unlessNotFound(assessment.listAssignments(caller, offeringId));
      if (assignments === undefined) continue;
      const view: StudentOfferingView = {
        offeringId,
        courseLabel: courseLabelOf(snapshot, offeringId),
        assignments,
        announcements: [],
        releasedFeedback: [],
        grades: [],
        submitted: new Set(),
      };
      const announcements = await unlessNotFound(this.listAnnouncements(caller, offeringId));
      view.announcements = (announcements?.announcements ?? []).filter((a) => a.published).map((a) => a.announcement);
      const submitted = new Set<AssignmentId>();
      for (const assignment of assignments) {
        for (const submission of await assessment.listSubmissions(caller, assignment.id)) {
          if (submission.studentPrincipalId !== studentId) continue;
          if (submission.withdrawnAt === undefined) submitted.add(assignment.id);
          const feedback = await unlessNotFound(assessment.getFeedback(caller, submission.id));
          if (feedback !== undefined) view.releasedFeedback.push({ submission, assignment, releasedAt: feedback.updatedAt });
        }
        for (const version of await assessment.officialGrades(caller, assignment.id, studentId)) {
          view.grades.push({ assignment, version: version.version, approvedAt: version.approval.approvedAt });
        }
      }
      view.submitted = submitted;
      views.push(view);
    }
    return views;
  }

  // Calendar

  /**
   * The caller's calendar between `from` and `to`: due dates of the assignments they can see,
   * announcements (scheduled ones too, for staff), and the dates of their classes' terms. Titles
   * and dates only, never grades or feedback.
   */
  async calendar(caller: Caller, from: Date, to: Date): Promise<CalendarEvent[]> {
    if (!(from < to) || to.getTime() - from.getTime() > MAX_CALENDAR_RANGE_DAYS * 86_400_000) {
      throw new SchoolOsError("validation-failed", `Ask for a range that ends after it starts and spans at most ${MAX_CALENDAR_RANGE_DAYS} days.`);
    }
    const snapshot = await this.#snapshot();
    const district = this.#options.districtId;
    const offerings = activeOfferings(snapshot, caller.principal.principalId);
    const events: CalendarEvent[] = [];
    const inRange = (iso: string) => {
      const time = Date.parse(iso);
      return time >= from.getTime() && time < to.getTime();
    };
    const terms = new Set<string>();
    for (const offeringId of offerings) {
      const label = courseLabelOf(snapshot, offeringId);
      const assignments = await unlessNotFound(this.#options.assessment.listAssignments(caller, offeringId));
      if (assignments === undefined) continue;
      const termId = snapshot.offerings.find((o) => o.id === offeringId)?.termId;
      if (termId !== undefined) terms.add(termId);
      for (const assignment of assignments) {
        if (!inRange(assignment.dueAt)) continue;
        events.push({
          uid: `due-${assignment.id}@${district}.schoolos`,
          kind: "assignment-due",
          title: `Due: ${assignment.title} — ${label}`,
          start: assignment.dueAt,
          allDay: false,
          offeringId,
          assignmentId: assignment.id,
        });
      }
      const listed = await unlessNotFound(this.listAnnouncements(caller, offeringId));
      for (const { announcement, published } of listed?.announcements ?? []) {
        if (!inRange(announcement.publishAt)) continue;
        events.push({
          uid: `announcement-${announcement.id}@${district}.schoolos`,
          kind: "announcement",
          title: `${published ? "Announcement" : "Scheduled announcement"}: ${announcement.title} — ${label}`,
          start: announcement.publishAt,
          allDay: false,
          offeringId,
          announcementId: announcement.id,
        });
      }
    }
    for (const term of snapshot.terms.filter((t) => terms.has(t.id))) {
      for (const [kind, date, verb] of [["term-start", term.startsOn, "begins"], ["term-end", term.endsOn, "ends"]] as const) {
        if (!inRange(`${date}T00:00:00.000Z`)) continue;
        events.push({ uid: `${kind}-${term.id}@${district}.schoolos`, kind, title: `${term.name} ${verb}`, start: date, allDay: true });
      }
    }
    return events.toSorted((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
  }

  /** Whether the caller has a calendar feed, and since when. */
  async feedStatus(caller: Caller): Promise<{ active: boolean; createdAt?: string }> {
    const feed = await this.#stores.calendarFeeds.get(caller.principal.principalId);
    return feed === undefined ? { active: false } : { active: true, createdAt: feed.createdAt };
  }

  /**
   * Makes the caller a new calendar feed token, ending any earlier one. The token is returned this
   * once; only its hash is kept.
   */
  async rotateFeed(caller: Caller): Promise<{ token: string; createdAt: string }> {
    const token = newFeedToken();
    const createdAt = this.#options.now().toISOString();
    await this.#stores.calendarFeeds.put({ principalId: caller.principal.principalId, tokenHash: await feedTokenHash(token), createdAt });
    return { token, createdAt };
  }

  /** Ends the caller's calendar feed. */
  async revokeFeed(caller: Caller): Promise<{ active: false }> {
    await this.#stores.calendarFeeds.delete(caller.principal.principalId);
    return { active: false };
  }

  /**
   * The iCalendar document a feed token opens, or `undefined` (answered 404) for a token that is
   * malformed, revoked, rotated away, or whose principal is no longer active. The calendar is read
   * as the feed's principal, through the `system` channel, since nobody signed in.
   */
  async feedIcs(token: string): Promise<string | undefined> {
    if (!isFeedToken(token)) return undefined;
    const feed = await this.#stores.calendarFeeds.findByHash(await feedTokenHash(token));
    if (feed === undefined) return undefined;
    const snapshot = await this.#snapshot();
    const principal = snapshot.principals.find((p) => p.id === feed.principalId);
    if (principal === undefined || principal.status !== "active" || (principal.kind !== "student" && principal.kind !== "staff")) return undefined;
    const now = this.#options.now();
    const caller: Caller = { principal: { principalId: principal.id, districtId: principal.districtId }, channel: "system", correlationId: crypto.randomUUID() };
    const events = await this.calendar(caller, new Date(now.getTime() - 30 * 86_400_000), new Date(now.getTime() + 365 * 86_400_000));
    return renderIcs({ name: `SchoolOS — ${snapshot.district.name}`, events, stamp: now });
  }

  // Notifications

  /**
   * Adds the notifications a student is owed for what happened in their classes in the last two
   * weeks: new announcements and assignments, assignments due within two days that they have not
   * submitted, released feedback and official grades. Each is derived from the student's own view
   * and keyed by what it is about, so running this again adds nothing twice. Returns those added.
   */
  async syncNotifications(caller: Caller): Promise<Notification[]> {
    const snapshot = await this.#snapshot();
    const principalId = caller.principal.principalId;
    const me = snapshot.principals.find((p) => p.id === principalId);
    if (me?.kind !== "student" || me.status !== "active") return [];
    const now = this.#options.now();
    const recent = (iso: string) => {
      const time = Date.parse(iso);
      return time <= now.getTime() && now.getTime() - time <= NOTIFY_WINDOW_MS;
    };
    const candidates: Notification[] = [];
    const add = async (kind: NotificationKind, key: string, fields: Pick<Notification, "offeringId" | "title" | "ref" | "occurredAt">) => {
      candidates.push({ id: await notificationIdFor(principalId, kind, key), principalId, kind, createdAt: now.toISOString(), ...fields });
    };
    for (const view of await this.studentView(caller)) {
      const { offeringId, courseLabel } = view;
      for (const a of view.announcements) {
        if (!recent(a.publishAt)) continue;
        await add("announcement", a.id, { offeringId, title: `New announcement in ${courseLabel}: ${a.title}`, ref: { announcementId: a.id }, occurredAt: a.publishAt });
      }
      for (const assignment of view.assignments) {
        if (recent(assignment.createdAt)) {
          await add("assignment-published", assignment.id, {
            offeringId, title: `New assignment in ${courseLabel}: ${assignment.title}`, ref: { assignmentId: assignment.id }, occurredAt: assignment.createdAt,
          });
        }
        const untilDue = Date.parse(assignment.dueAt) - now.getTime();
        if (untilDue > 0 && untilDue <= DUE_SOON_MS && !view.submitted.has(assignment.id)) {
          // Keyed by the due date too, so a moved deadline earns a new reminder.
          await add("assignment-due-soon", `${assignment.id} ${assignment.dueAt}`, {
            offeringId, title: `Due soon in ${courseLabel}: ${assignment.title}`, ref: { assignmentId: assignment.id }, occurredAt: now.toISOString(),
          });
        }
      }
      for (const { submission, assignment, releasedAt } of view.releasedFeedback) {
        if (!recent(releasedAt)) continue;
        await add("feedback-released", submission.id, {
          offeringId, title: `Feedback on ${assignment.title} (${courseLabel})`, ref: { assignmentId: assignment.id, submissionId: submission.id }, occurredAt: releasedAt,
        });
      }
      for (const { assignment, version, approvedAt } of view.grades) {
        if (!recent(approvedAt)) continue;
        await add("grade-released", `${assignment.id} ${version}`, {
          offeringId, title: `Grade posted for ${assignment.title} (${courseLabel})`, ref: { assignmentId: assignment.id }, occurredAt: approvedAt,
        });
      }
    }
    return this.#stores.notifications.addIfAbsent(candidates);
  }

  /** The caller's newest notifications, after bringing them up to date, and how many are unread. */
  async listNotifications(caller: Caller): Promise<{ notifications: Notification[]; unread: number }> {
    await this.syncNotifications(caller);
    const all = await this.#stores.notifications.list(caller.principal.principalId);
    return { notifications: all.slice(0, NOTIFICATION_PAGE), unread: all.filter((n) => n.readAt === undefined).length };
  }

  /** Marks the caller's notifications read: the ones named, or all of them. Others' are untouched. */
  async markRead(caller: Caller, which: { ids?: readonly NotificationId[] | undefined; all?: boolean | undefined }): Promise<{ unread: number }> {
    const all = await this.#stores.notifications.list(caller.principal.principalId);
    const at = this.#options.now().toISOString();
    const ids = new Set(which.ids ?? []);
    const marked = all.filter((n) => n.readAt === undefined && (which.all === true || ids.has(n.id))).map((n) => ({ ...n, readAt: at }));
    await this.#stores.notifications.update(marked);
    return { unread: all.filter((n) => n.readAt === undefined).length - marked.length };
  }

  // Preferences

  /** The caller's email preferences, and whether the district has an address to send to. */
  async preferences(caller: Caller): Promise<{ email: EmailPreferences; hasEmailAddress: boolean; emailEnabled: boolean }> {
    const snapshot = await this.#snapshot();
    const email = snapshot.principals.find((p) => p.id === caller.principal.principalId)?.email;
    return {
      email: (await this.#stores.preferences.get(caller.principal.principalId)) ?? DEFAULT_EMAIL_PREFERENCES,
      hasEmailAddress: email !== undefined && isDeliverableAddress(email),
      emailEnabled: this.#options.mail !== undefined,
    };
  }

  /** Changes the caller's own email preferences. A kind not named keeps its setting. */
  async setPreferences(caller: Caller, patch: Partial<EmailPreferences>): Promise<{ email: EmailPreferences; hasEmailAddress: boolean; emailEnabled: boolean }> {
    const current = (await this.#stores.preferences.get(caller.principal.principalId)) ?? DEFAULT_EMAIL_PREFERENCES;
    const next = EmailPreferences.parse({ ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
    await this.#stores.preferences.put(caller.principal.principalId, next);
    return this.preferences(caller);
  }

  // Jobs

  /**
   * The periodic notification job: brings every active student's notifications up to date, then
   * emails the ones still owed an email, honouring each principal's preferences. A notification
   * already read in the app is not emailed. A failed send is left to the next run.
   */
  async runNotificationJob(): Promise<{ added: number; emailed: number; skipped: number; failed: number }> {
    const snapshot = await this.#snapshot();
    let added = 0;
    for (const student of snapshot.principals.filter((p) => p.kind === "student" && p.status === "active")) {
      const caller: Caller = { principal: { principalId: student.id, districtId: student.districtId }, channel: "system", correlationId: crypto.randomUUID() };
      added += (await this.syncNotifications(caller)).length;
    }
    const counts = { added, emailed: 0, skipped: 0, failed: 0 };
    const at = () => this.#options.now().toISOString();
    for (const notification of (await this.#stores.notifications.pendingEmail()).slice(0, EMAILS_PER_RUN)) {
      const skip = async (reason: "opted-out" | "no-address" | "read" | "disabled") => {
        await this.#stores.notifications.update([{ ...notification, email: { status: "skipped", at: at(), reason } }]);
        counts.skipped++;
      };
      const principal = snapshot.principals.find((p) => p.id === notification.principalId);
      const preferences = (await this.#stores.preferences.get(notification.principalId)) ?? DEFAULT_EMAIL_PREFERENCES;
      if (notification.readAt !== undefined) await skip("read");
      else if (this.#options.mail === undefined) await skip("disabled");
      else if (principal?.email === undefined || !isDeliverableAddress(principal.email) || principal.status !== "active") await skip("no-address");
      else if (!preferences[preferenceFor(notification.kind)]) await skip("opted-out");
      else {
        try {
          await this.#options.mail.send(notificationEmail(notification, principal.email, this.#options.appUrl));
          await this.#stores.notifications.update([{ ...notification, email: { status: "sent", at: at() } }]);
          counts.emailed++;
        } catch {
          counts.failed++;
        }
      }
    }
    return counts;
  }
}

/** The later of a requested time and now, as a UTC timestamp: nothing is published in the past. */
function laterOf(requested: string | undefined, now: Date): string {
  if (requested === undefined) return now.toISOString();
  const time = Date.parse(requested);
  return time > now.getTime() ? new Date(time).toISOString() : now.toISOString();
}

/** The offerings `principalId` is actively enrolled in, as `role` if given. */
export function activeOfferings(snapshot: DistrictDirectorySnapshot, principalId: PrincipalId, role?: "student"): OfferingId[] {
  return [...new Set(snapshot.enrollments
    .filter((e) => e.principalId === principalId && e.status === "active" && (role === undefined || e.role === role))
    .map((e) => e.offeringId))];
}

/** The email for one notification: its title and where to read it. Never a score or feedback text. */
export function notificationEmail(notification: Notification, to: string, appUrl: string | undefined) {
  const link = appUrl === undefined ? "Sign in to SchoolOS to read it." : `Read it in SchoolOS: ${appUrl}`;
  const footer = "You can turn these emails off in SchoolOS settings.";
  return {
    to,
    subject: notification.title,
    text: `${notification.title}\n\n${link}\n\n${footer}\n`,
    html: `<p>${escapeHtml(notification.title)}</p>`
      + (appUrl === undefined ? `<p>${escapeHtml(link)}</p>` : `<p><a href="${escapeHtml(appUrl)}">Read it in SchoolOS</a></p>`)
      + `<p style="color:#666">${escapeHtml(footer)}</p>`,
  };
}

