// How the calendar screen lays events out by day, in the student's own time zone. All-day events
// (term dates) carry a date, not a moment, so they stay on that date wherever the student is.
import type { CalendarEvent } from "../model.ts";

/** A local calendar day, `YYYY-MM-DD`. */
export const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** The day an event falls on, for the student. */
export const eventDay = (event: CalendarEvent): string => (event.allDay ? event.start : dayKey(new Date(event.start)));

/** Local midnight of the Monday of the week `date` is in. */
export const startOfWeek = (date: Date): Date => {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
};

/** `date` moved by `days` local days. */
export const addDays = (date: Date, days: number): Date => {
  const moved = new Date(date);
  moved.setDate(moved.getDate() + days);
  return moved;
};

/** The local date a `YYYY-MM-DD` key names. */
export const dateOfKey = (key: string): Date => {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
};

/** Events grouped by day, in day order, each day's events in time order (all-day first). */
export const byDay = (events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> => {
  const days = new Map<string, CalendarEvent[]>();
  const ordered = events.toSorted((a, b) => eventDay(a).localeCompare(eventDay(b)) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  for (const event of ordered) days.set(eventDay(event), [...(days.get(eventDay(event)) ?? []), event]);
  return days;
};
