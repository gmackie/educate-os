// SCHO-328: seeded work falls due on a school day at 3:30 PM in the time zone it is seeded for.
import { describe, expect, it } from "vitest";
import { schoolDayDue } from "../src/school-day.ts";

describe("schoolDayDue", () => {
  it("is 3:30 PM on the day in the given time zone, in UTC", () => {
    // Wednesday 4 November 2026, 11:28 PM UTC: still Wednesday in Detroit (EST, UTC-5).
    const now = new Date("2026-11-04T23:28:00Z");
    expect(schoolDayDue(now, "America/Detroit")(1)).toBe("2026-11-05T20:30:00.000Z");
    expect(schoolDayDue(now, "America/Los_Angeles")(1)).toBe("2026-11-05T23:30:00.000Z");
    // Already Thursday in Tokyo, so one day on is Friday.
    expect(schoolDayDue(now, "Asia/Tokyo")(1)).toBe("2026-11-06T06:30:00.000Z");
  });

  it("moves a weekend to the Monday after", () => {
    const friday = new Date("2026-11-06T14:00:00Z");
    expect(schoolDayDue(friday, "America/Detroit")(1)).toBe("2026-11-09T20:30:00.000Z");
    expect(schoolDayDue(friday, "America/Detroit")(2)).toBe("2026-11-09T20:30:00.000Z");
    expect(schoolDayDue(friday, "America/Detroit")(3)).toBe("2026-11-09T20:30:00.000Z");
  });

  it("keeps 3:30 PM across a daylight-saving change", () => {
    // Detroit leaves daylight saving on Sunday 1 November 2026.
    const thursday = new Date("2026-10-29T12:00:00Z");
    expect(schoolDayDue(thursday, "America/Detroit")(1)).toBe("2026-10-30T19:30:00.000Z");
    expect(schoolDayDue(thursday, "America/Detroit")(4)).toBe("2026-11-02T20:30:00.000Z");
  });
});
