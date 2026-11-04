// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GoogleCalendarSession, CalendarEvent } from "../../../../gatekeeper-google/src/calendar-types.js";
import { calendarMidnight, readSource } from "../files/lib/source.ts";
it("uses local midnight across DST and preserves exclusive all-day ends", async () => {
  const events: CalendarEvent[] = [{ id: "a", title: "Field day", status: "confirmed", start: { kind: "date", date: "2026-11-02" }, end: { kind: "date", date: "2026-11-03" } }, { id: "b", title: "Cancelled", status: "cancelled", start: { kind: "date", date: "2026-11-02" }, end: { kind: "date", date: "2026-11-03" } }];
  const session: Pick<GoogleCalendarSession, "getCalendar" | "listEvents"> = { getCalendar: async () => ({ id: "selected", summary: "Teaching", timeZone: "America/Detroit" }), listEvents: vi.fn(async () => events) };
  const board = await readSource(session, "2026-10-30");
  expect(session.listEvents).toHaveBeenCalledWith({ timeMin: new Date("2026-10-30T04:00:00Z"), timeMax: new Date("2026-11-06T05:00:00Z"), includeDescriptions: false });
  expect(board.cards).toHaveLength(1);
  expect(board.cards[0]!.detail).toContain("2026-11-03 (exclusive)");
});
it("rejects invalid dates and missing or revoked capabilities", async () => {
  expect(() => calendarMidnight("2026-02-30", "UTC")).toThrow();
  await expect(readSource(undefined, "2026-11-04")).rejects.toThrow("CALENDAR");
  await expect(readSource({ getCalendar: async () => { throw new Error("revoked"); }, listEvents: vi.fn() }, "2026-11-04")).rejects.toThrow("revoked");
});
