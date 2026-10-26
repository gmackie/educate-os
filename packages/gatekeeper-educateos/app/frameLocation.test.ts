import { describe, expect, it } from "vitest";
import { createFrameLocation } from "./frameLocation.ts";

const started = (path: string) => {
  const reported: string[] = [];
  return { location: createFrameLocation(path, (moved) => reported.push(moved)), reported };
};

describe("the School app's place", () => {
  it("starts each screen at the route the Workshop URL names", () => {
    expect(started("/teach/classes/off_1/gradebook").location.hash.read()).toBe("#/classes/off_1/gradebook");
    expect(started("/learn/grades").location.history.location.pathname).toBe("/grades");
  });

  it("reports the screen's own moves, so the Workshop URL follows them", () => {
    const { location, reported } = started("/admin");
    location.hash.assign("#/guardians");
    expect(location.read()).toBe("/admin/guardians");

    location.show("/learn");
    location.history.push("/calendar");
    expect(location.read()).toBe("/learn/calendar");
    expect(reported).toStrictEqual(["/admin/guardians", "/learn/calendar"]);
  });

  it("follows the host's moves without reporting them back", () => {
    const { location, reported } = started("/learn/grades");
    location.show("/teach/classes/off_1/roster");
    expect(location.hash.read()).toBe("#/classes/off_1/roster");
    location.show("/learn/calendar");
    expect(location.history.location.pathname).toBe("/calendar");
    expect(location.read()).toBe("/learn/calendar");
    expect(reported).toStrictEqual([]);
  });

  it("reports a move to another screen the app makes itself", () => {
    const { location, reported } = started("/admin");
    location.go("/teach");
    expect(location.read()).toBe("/teach");
    expect(reported).toStrictEqual(["/teach"]);
  });
});
