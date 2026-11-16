// Snapshot of the owning gatekeeper contract; structural compatibility is checked in repo tests.
/** The availability lookup scope chosen when this calendar connection was configured. */
export type CalendarAvailabilityMode = "thisCalendar" | "allVisible";

/** Capabilities enabled for this Google Calendar connection. */
export type GoogleCalendarCapabilities = {
  /**
   * `thisCalendar`: `checkAvailability` may only query the bound calendar's own free/busy.
   * `allVisible`: `checkAvailability` may query any calendar visible to the connected Google
   * account. Only busy time blocks are returned, never event details from other calendars.
   */
  availabilityMode: CalendarAvailabilityMode;
};

/** Metadata about the Google Calendar this session is scoped to. */
export type GoogleCalendarInfo = {
  /** Calendar ID, e.g. `primary` or `person@example.com`. */
  id: string;
  /** Human-readable calendar name. */
  summary: string;
  /** Optional calendar description. */
  description?: string;
  /** Calendar time zone, e.g. `America/Los_Angeles`. */
  timeZone?: string;
  /** User's Google Calendar access role on this calendar. */
  accessRole?: "none" | "freeBusyReader" | "reader" | "writerWithoutPrivateAccess" | "writer" | "owner";
  /** Whether this is the user's primary calendar. */
  primary?: boolean;
};

/**
 * A calendar date or date/time.
 *
 * All-day events use `{ kind: "date", date: "YYYY-MM-DD" }`. Google Calendar treats the end
 * date as exclusive, so a one-day all-day event on 2026-06-09 ends on 2026-06-10.
 *
 * Timed events use `{ kind: "dateTime", dateTime: Date, timeZone?: string }`.
 */
export type CalendarTime =
  | { kind: "date"; date: string }
  | { kind: "dateTime"; dateTime: Date; timeZone?: string };

/** A Google Calendar event. */
export type CalendarEvent = {
  /**
   * Google Calendar event ID. Newly created events that have not yet been committed to Google
   * Calendar use a temporary ID of the form `pending:create:{n}`.
   */
  id: string;
  /** Event title. */
  title: string;
  /** Start date/time. */
  start: CalendarTime;
  /** End date/time. */
  end: CalendarTime;
  /** Event status. */
  status: "confirmed" | "tentative" | "cancelled";
  /** Event location, if any. */
  location?: string;
  /** Event description/body, if requested and visible. */
  description?: string;
  /** Attendees, if requested and visible. */

  /** Link to open the event in Google Calendar. */
  htmlLink?: string;
  /** Whether the event blocks the calendar (`opaque`) or is shown as free (`transparent`). */
  transparency?: "opaque" | "transparent";
  /** Event visibility, if set. */
  visibility?: "default" | "public" | "private" | "confidential";
  /** Whether this event is part of a recurring series. */
  recurringEventId?: string;
  /** True for events that have been submitted but not yet committed to Google Calendar. */
  pending?: boolean;
};

/** Options for listing events on the selected calendar. */
export type CalendarListEventsOptions = {
  /** Start of the time window to list. */
  timeMin: Date;
  /** End of the time window to list. */
  timeMax: Date;
  /** Include event descriptions/bodies. Defaults to false. */
  includeDescriptions?: boolean;
};

/** Read-only slice of GoogleCalendarSession; verified against the owning contract in tests. */
export interface GoogleCalendarSession {
  getCalendar(): Promise<GoogleCalendarInfo>;
  listEvents(opts: CalendarListEventsOptions): Promise<CalendarEvent[]>;
}
