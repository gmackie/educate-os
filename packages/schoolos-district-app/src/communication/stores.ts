// Communication (SCHO-189): where announcements, notes, notifications, feeds, preferences and the
// digest ledger are kept. The in-memory stores here back tests and the local harness; the district
// Worker uses the Durable Object stores in `durable-stores.ts`, which keep the same contracts.
import { SchoolOsError, type OfferingId, type PrincipalId } from "@schoolos/contracts";
import {
  Announcement,
  CalendarFeed,
  DigestLedgerEntry,
  EmailPreferences,
  Notification,
  WeeklyNote,
  type AnnouncementId,
  type IsoWeek,
  type NotificationId,
} from "./model.ts";

/** An offering's announcements. */
export interface AnnouncementStore {
  /** Every announcement of an offering, retracted ones included, oldest `publishAt` first. */
  list(offeringId: OfferingId): Promise<Announcement[]>;
  /** One announcement. */
  get(id: AnnouncementId): Promise<Announcement | undefined>;
  /** Adds an announcement, or replaces the one with its ID. */
  put(announcement: Announcement): Promise<void>;
}

/** Teachers' weekly notes to families, one per offering and week. */
export interface WeeklyNoteStore {
  /** The note for an offering and week. */
  get(offeringId: OfferingId, week: IsoWeek): Promise<WeeklyNote | undefined>;
  /** Sets the note for its offering and week. */
  put(note: WeeklyNote): Promise<void>;
  /** Removes the note for an offering and week. */
  delete(offeringId: OfferingId, week: IsoWeek): Promise<void>;
}

/** Each principal's notifications. */
export interface NotificationStore {
  /** A principal's notifications, newest `occurredAt` first. */
  list(principalId: PrincipalId): Promise<Notification[]>;
  /**
   * Adds each notification whose ID is not stored yet, in one step, and returns those it added.
   * A notification's ID is derived from what it is about, so this is what keeps generation idempotent.
   */
  addIfAbsent(notifications: readonly Notification[]): Promise<Notification[]>;
  /** Replaces stored notifications, matched by ID. An ID not stored is ignored. */
  update(notifications: readonly Notification[]): Promise<void>;
  /** Every notification not yet emailed or skipped, oldest first. */
  pendingEmail(): Promise<Notification[]>;
}

/** Calendar feeds, at most one per principal. */
export interface CalendarFeedStore {
  /** A principal's feed. */
  get(principalId: PrincipalId): Promise<CalendarFeed | undefined>;
  /** The feed whose token hashes to `tokenHash`. */
  findByHash(tokenHash: string): Promise<CalendarFeed | undefined>;
  /** Sets a principal's feed, replacing any other. */
  put(feed: CalendarFeed): Promise<void>;
  /** Removes a principal's feed. */
  delete(principalId: PrincipalId): Promise<void>;
}

/** Each principal's email preferences. */
export interface PreferenceStore {
  /** A principal's preferences, if they have set any. */
  get(principalId: PrincipalId): Promise<EmailPreferences | undefined>;
  /** Sets a principal's preferences. */
  put(principalId: PrincipalId, preferences: EmailPreferences): Promise<void>;
}

/** The family digest's send ledger: one entry per guardian and week. */
export interface DigestLedgerStore {
  /** The entry for a guardian and week. */
  get(guardianPrincipalId: PrincipalId, week: IsoWeek): Promise<DigestLedgerEntry | undefined>;
  /**
   * Claims a guardian's week for sending, as `sending`, in one step: only if it has no entry or
   * only a `failed` one. Of two runs racing for one week, exactly one claims it.
   */
  claim(entry: DigestLedgerEntry): Promise<boolean>;
  /** Records how a claimed week ended. */
  finish(entry: DigestLedgerEntry): Promise<void>;
}

/** Every communication store. */
export interface CommunicationStores {
  announcements: AnnouncementStore;
  weeklyNotes: WeeklyNoteStore;
  notifications: NotificationStore;
  calendarFeeds: CalendarFeedStore;
  preferences: PreferenceStore;
  digestLedger: DigestLedgerStore;
}

/** An {@link AnnouncementStore} in memory. */
export class InMemoryAnnouncementStore implements AnnouncementStore {
  readonly #items = new Map<string, Announcement>();

  async list(offeringId: OfferingId): Promise<Announcement[]> {
    return structuredClone([...this.#items.values()].filter((a) => a.offeringId === offeringId).toSorted(byPublishAt));
  }

  async get(id: AnnouncementId): Promise<Announcement | undefined> {
    return structuredClone(this.#items.get(id));
  }

  async put(announcement: Announcement): Promise<void> {
    const parsed = Announcement.parse(announcement);
    this.#items.set(parsed.id, parsed);
  }
}

/** Orders announcements by `publishAt`, then ID. */
export const byPublishAt = (a: Announcement, b: Announcement): number =>
  a.publishAt.localeCompare(b.publishAt) || a.id.localeCompare(b.id);

/** A {@link WeeklyNoteStore} in memory. */
export class InMemoryWeeklyNoteStore implements WeeklyNoteStore {
  readonly #notes = new Map<string, WeeklyNote>();

  async get(offeringId: OfferingId, week: IsoWeek): Promise<WeeklyNote | undefined> {
    return structuredClone(this.#notes.get(`${offeringId} ${week}`));
  }

  async put(note: WeeklyNote): Promise<void> {
    const parsed = WeeklyNote.parse(note);
    this.#notes.set(`${parsed.offeringId} ${parsed.week}`, parsed);
  }

  async delete(offeringId: OfferingId, week: IsoWeek): Promise<void> {
    this.#notes.delete(`${offeringId} ${week}`);
  }
}

/** Orders notifications newest first. */
export const newestFirst = (a: Notification, b: Notification): number =>
  b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id);

/** A {@link NotificationStore} in memory. */
export class InMemoryNotificationStore implements NotificationStore {
  readonly #items = new Map<NotificationId, Notification>();

  async list(principalId: PrincipalId): Promise<Notification[]> {
    return structuredClone([...this.#items.values()].filter((n) => n.principalId === principalId).toSorted(newestFirst));
  }

  async addIfAbsent(notifications: readonly Notification[]): Promise<Notification[]> {
    const added: Notification[] = [];
    for (const notification of notifications) {
      const parsed = Notification.parse(notification);
      if (this.#items.has(parsed.id)) continue;
      this.#items.set(parsed.id, parsed);
      added.push(structuredClone(parsed));
    }
    return added;
  }

  async update(notifications: readonly Notification[]): Promise<void> {
    for (const notification of notifications) {
      const parsed = Notification.parse(notification);
      if (this.#items.has(parsed.id)) this.#items.set(parsed.id, parsed);
    }
  }

  async pendingEmail(): Promise<Notification[]> {
    return structuredClone([...this.#items.values()].filter((n) => n.email === undefined).toSorted((a, b) => -newestFirst(a, b)));
  }
}

/** A {@link CalendarFeedStore} in memory. */
export class InMemoryCalendarFeedStore implements CalendarFeedStore {
  readonly #feeds = new Map<PrincipalId, CalendarFeed>();

  async get(principalId: PrincipalId): Promise<CalendarFeed | undefined> {
    return structuredClone(this.#feeds.get(principalId));
  }

  async findByHash(tokenHash: string): Promise<CalendarFeed | undefined> {
    return structuredClone([...this.#feeds.values()].find((f) => f.tokenHash === tokenHash));
  }

  async put(feed: CalendarFeed): Promise<void> {
    const parsed = CalendarFeed.parse(feed);
    if ([...this.#feeds.values()].some((f) => f.tokenHash === parsed.tokenHash && f.principalId !== parsed.principalId)) {
      throw new SchoolOsError("conflict", "That calendar token is already in use.");
    }
    this.#feeds.set(parsed.principalId, parsed);
  }

  async delete(principalId: PrincipalId): Promise<void> {
    this.#feeds.delete(principalId);
  }
}

/** A {@link PreferenceStore} in memory. */
export class InMemoryPreferenceStore implements PreferenceStore {
  readonly #preferences = new Map<PrincipalId, EmailPreferences>();

  async get(principalId: PrincipalId): Promise<EmailPreferences | undefined> {
    return structuredClone(this.#preferences.get(principalId));
  }

  async put(principalId: PrincipalId, preferences: EmailPreferences): Promise<void> {
    this.#preferences.set(principalId, EmailPreferences.parse(preferences));
  }
}

/** A {@link DigestLedgerStore} in memory. */
export class InMemoryDigestLedgerStore implements DigestLedgerStore {
  readonly #entries = new Map<string, DigestLedgerEntry>();

  async get(guardianPrincipalId: PrincipalId, week: IsoWeek): Promise<DigestLedgerEntry | undefined> {
    return structuredClone(this.#entries.get(`${guardianPrincipalId} ${week}`));
  }

  async claim(entry: DigestLedgerEntry): Promise<boolean> {
    const parsed = DigestLedgerEntry.parse(entry);
    const key = `${parsed.guardianPrincipalId} ${parsed.week}`;
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing.status !== "failed") return false;
    this.#entries.set(key, parsed);
    return true;
  }

  async finish(entry: DigestLedgerEntry): Promise<void> {
    const parsed = DigestLedgerEntry.parse(entry);
    this.#entries.set(`${parsed.guardianPrincipalId} ${parsed.week}`, parsed);
  }
}

/** Every communication store, in memory. */
export function inMemoryCommunicationStores(): CommunicationStores {
  return {
    announcements: new InMemoryAnnouncementStore(),
    weeklyNotes: new InMemoryWeeklyNoteStore(),
    notifications: new InMemoryNotificationStore(),
    calendarFeeds: new InMemoryCalendarFeedStore(),
    preferences: new InMemoryPreferenceStore(),
    digestLedger: new InMemoryDigestLedgerStore(),
  };
}
