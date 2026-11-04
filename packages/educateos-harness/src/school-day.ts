// When seeded work falls due: on a school day, at a time a teacher would set. Shared by the
// in-browser demo, which uses the visitor's own time zone, and the in-Worker showcase seed, which
// uses the district's.

/** The hour and minute seeded work falls due: 3:30 PM, the end of a school day. */
const DUE_HOUR = 15;
const DUE_MINUTE = 30;

/** The wall-clock fields of `instant` in `timeZone`. */
const wallClock = (instant: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)!.value);
  return { year: field("year"), month: field("month"), day: field("day"), hour: field("hour"), minute: field("minute") };
};

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in milliseconds. */
const offsetAt = (instant: number, timeZone: string) => {
  const local = wallClock(instant, timeZone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - Math.floor(instant / 60_000) * 60_000;
};

/**
 * When an activity due `days` from `today` falls due: that school day at 3:30 PM in `timeZone` (an
 * IANA name; the host's own by default), a weekend moved to the Monday after, as an ISO date-time
 * (UTC). The day is counted on `timeZone`'s calendar, so a seed run late in the evening UTC still
 * counts from the district's today.
 */
export const schoolDayDue = (today: Date, timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone) => (days: number): string => {
  const local = wallClock(today.getTime(), timeZone);
  // The calendar arithmetic is done in UTC, where every day is 24 hours long.
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  const weekday = date.getUTCDay();
  if (weekday === 6) date.setUTCDate(date.getUTCDate() + 2);
  if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), DUE_HOUR, DUE_MINUTE);
  // The offset at the wall-clock time read as UTC is within a day of right; one more pass settles it
  // across a daylight-saving change, which never falls at 3:30 PM.
  const first = wall - offsetAt(wall, timeZone);
  return new Date(wall - offsetAt(first, timeZone)).toISOString();
};
