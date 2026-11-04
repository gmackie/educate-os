import type { GoogleCalendarSession } from "./connector.d.ts";
import { sourceUrl, type BoardResult } from "@gadgets/bundled-blueprints/libraries/teacher-board/server";

/** Midnight of a calendar date in the selected calendar's IANA time zone, including DST. */
export function calendarMidnight(day: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) {
    throw new Error("Choose a valid start date.");
  }
  const target = Date.parse(day + "T00:00:00Z");
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    const local = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const difference = target - local;
    if (difference === 0) return new Date(instant);
    instant += difference;
  }
  throw new Error("This date has no midnight in the calendar's time zone. Choose another start date.");
}

/** Reads exactly seven local calendar days, without descriptions, attendees or external writes. */
export async function readSource(calendar: Pick<GoogleCalendarSession, "getCalendar" | "listEvents"> | undefined, day: string): Promise<BoardResult> {
  if (!calendar) throw new Error("Connect the CALENDAR binding to a selected Google Calendar.");
  const info = await calendar.getCalendar();
  const zone = info.timeZone ?? "UTC";
  const timeMin = calendarMidnight(day, zone);
  const endDay = new Date(Date.parse(day + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10);
  const timeMax = calendarMidnight(endDay, zone);
  const events = await calendar.listEvents({ timeMin, timeMax, includeDescriptions: false });
  const format = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const start = (event: typeof events[number]) => event.start.kind === "date" ? event.start.date : event.start.dateTime.toISOString();
  return {
    title: info.summary,
    subtitle: `${day} through ${endDay} (exclusive) · ${zone} · read-only`,
    refreshedAt: new Date().toISOString(),
    cards: events.filter(event => event.status !== "cancelled").sort((a, b) => start(a).localeCompare(start(b))).map(event => ({
      id: event.id, title: event.title,
      label: event.pending ? "Awaiting approval" : event.status === "tentative" ? "Tentative" : "Calendar event",
      detail: event.start.kind === "date"
        ? `All day · ${event.start.date} through ${event.end.kind === "date" ? event.end.date + " (exclusive)" : format.format(event.end.dateTime)}`
        : `${format.format(event.start.dateTime)} – ${event.end.kind === "dateTime" ? format.format(event.end.dateTime) : event.end.date} · ${zone}`,
      url: sourceUrl(event.htmlLink),
    })),
  };
}
