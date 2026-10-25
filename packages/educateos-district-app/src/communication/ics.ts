// Communication (SCHO-189): a principal's calendar as an RFC 5545 iCalendar document, for the
// subscribe-by-URL feed. Every time is in UTC; all-day events (term dates) are DATE values.

/** One calendar event, as the calendar route and the feed share it. */
export interface CalendarEventLike {
  /** Stable across regenerations, so a subscribed calendar updates an event rather than duplicating it. */
  uid: string;
  title: string;
  /** A UTC timestamp, or a `YYYY-MM-DD` date for an all-day event. */
  start: string;
  allDay: boolean;
}

/** Escapes a TEXT value (RFC 5545 §3.3.11): backslash, semicolon, comma and newlines. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    // Other control characters (a tab aside) are not allowed in TEXT.
    .split("")
    .filter((char) => char === "\t" || (char >= " " && char !== "\u007f"))
    .join("");
}

const encoder = new TextEncoder();

/**
 * Folds a content line to at most 75 octets per physical line (RFC 5545 §3.1), continuing with
 * CRLF and one space, and never splitting a UTF-8 sequence.
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).byteLength;
    // Continuation lines start with a space, which counts toward their 75.
    const limit = out.length === 0 ? 75 : 74;
    if (octets + size > limit) {
      out.push(current);
      current = "";
      octets = 0;
    }
    current += char;
    octets += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** A UTC timestamp as a DATE-TIME value, `20261120T220000Z`. */
export function icsDateTime(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** A `YYYY-MM-DD` date as a DATE value, `20261120`. */
function icsDate(date: string): string {
  return date.replace(/-/g, "");
}

/** The day after a `YYYY-MM-DD` date, the exclusive end of a one-day event. */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Renders events as a VCALENDAR. `stamp` is the DTSTAMP every event carries: when this copy was
 * generated. The output uses CRLF line endings and folds long lines.
 */
export function renderIcs(options: { name: string; events: readonly CalendarEventLike[]; stamp: Date }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//EducateOS//District Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(options.name)}`,
    "X-WR-TIMEZONE:UTC",
  ];
  const stamp = icsDateTime(options.stamp.toISOString());
  for (const event of options.events) {
    lines.push("BEGIN:VEVENT", `UID:${escapeIcsText(event.uid)}`, `DTSTAMP:${stamp}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(event.start)}`, `DTEND;VALUE=DATE:${icsDate(nextDay(event.start))}`);
    } else {
      // A due date is a moment: with no DTEND the event ends where it starts (RFC 5545 §3.6.1).
      lines.push(`DTSTART:${icsDateTime(event.start)}`);
    }
    lines.push(`SUMMARY:${escapeIcsText(event.title)}`, "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
