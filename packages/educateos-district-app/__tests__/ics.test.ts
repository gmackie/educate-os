// SCHO-189: the iCalendar renderer against a golden calendar, and the RFC 5545 rules it must keep.
// The golden is kept here line by line (a CRLF file would not survive the repository's LF
// checkouts); change it only for an intentional change to the feed, and review the diff.
import { describe, expect, it } from "vitest";
import { escapeIcsText, foldIcsLine, isoWeekBounds, isoWeekOf, digestWeekOf, renderIcs } from "../src/index.ts";

// The UIDs keep the domain they had before the rename (SCHO-232): calendar clients key events by UID.
/** The golden calendar, one content line per entry; continuation lines start with a space. */
const GOLDEN = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//EducateOS//District Calendar//EN",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:EducateOS — Northfield\\, synthetic",
  "X-WR-TIMEZONE:UTC",
  "BEGIN:VEVENT",
  "UID:term-start-trm_nf-2026-fall@dst_northfield.schoolos", // rename-educateos: keep
  "DTSTAMP:20261023T120000Z",
  "DTSTART;VALUE=DATE:20260831",
  "DTEND;VALUE=DATE:20260901",
  "SUMMARY:Fall 2026 begins",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:due-asg_essay@dst_northfield.schoolos", // rename-educateos: keep
  "DTSTAMP:20261023T120000Z",
  "DTSTART:20261120T220000Z",
  "SUMMARY:Due: Should the school day start later? Yes\\; no\\, maybe\\\\later —",
  "  English 9 (Period 3)",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:announcement-ann_1@dst_northfield.schoolos", // rename-educateos: keep
  "DTSTAMP:20261023T120000Z",
  "DTSTART:20261026T133000Z",
  "SUMMARY:Announcement: Café trip\\, line one\\nline two — résumé workshop",
  "  for everyone in the whole school\\, all welcome",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n") + "\r\n";

const events = [
  { uid: "term-start-trm_nf-2026-fall@dst_northfield.schoolos", title: "Fall 2026 begins", start: "2026-08-31", allDay: true }, // rename-educateos: keep
  {
    uid: "due-asg_essay@dst_northfield.schoolos", // rename-educateos: keep
    title: "Due: Should the school day start later? Yes; no, maybe\\later — English 9 (Period 3)",
    start: "2026-11-20T17:00:00-05:00",
    allDay: false,
  },
  {
    uid: "announcement-ann_1@dst_northfield.schoolos", // rename-educateos: keep
    title: "Announcement: Café trip, line one\nline two — résumé workshop for everyone in the whole school, all welcome",
    start: "2026-10-26T13:30:00.000Z",
    allDay: false,
  },
];

describe("renderIcs", () => {
  it("matches the golden calendar", () => {
    const ics = renderIcs({ name: "EducateOS — Northfield, synthetic", events, stamp: new Date("2026-10-23T12:00:00Z") });
    expect(ics).toBe(GOLDEN);
  });

  it("uses CRLF, folds every line to 75 octets without splitting a character, and unfolds back", () => {
    const ics = renderIcs({ name: "x", events, stamp: new Date("2026-10-23T12:00:00Z") });
    const lines = ics.split("\r\n");
    expect(lines.at(-1)).toBe("");
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
    for (const line of lines) expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("SUMMARY:Announcement: Café trip\\, line one\\nline two — résumé workshop for everyone in the whole school\\, all welcome\r\n");
    expect(unfolded).toContain("DTSTART:20261120T220000Z\r\n");
    expect(unfolded).toContain("DTSTART;VALUE=DATE:20260831\r\nDTEND;VALUE=DATE:20260901\r\n");
  });

  it("escapes TEXT values and folds multi-byte text on character boundaries", () => {
    expect(escapeIcsText("a\\b;c,d\ne\r\nf\u0007")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
    const folded = foldIcsLine(`SUMMARY:${"é".repeat(60)}`);
    for (const line of folded.split("\r\n")) expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"é".repeat(60)}`);
  });
});

describe("ISO weeks", () => {
  it("numbers weeks as ISO 8601 does, across year boundaries", () => {
    expect(isoWeekOf(new Date("2026-10-25T14:00:00Z"))).toBe("2026-W43");
    expect(isoWeekOf(new Date("2026-10-26T00:00:00Z"))).toBe("2026-W44");
    expect(isoWeekOf(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(isoWeekOf(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
    expect(isoWeekBounds("2026-W44")).toStrictEqual({ start: new Date("2026-10-26T00:00:00Z"), end: new Date("2026-11-02T00:00:00Z") });
    expect(isoWeekBounds("2025-W01").start).toStrictEqual(new Date("2024-12-30T00:00:00Z"));
    // A digest sent on a Sunday covers the week that starts the next morning.
    expect(digestWeekOf(new Date("2026-10-25T14:00:00Z"))).toBe("2026-W44");
  });
});
