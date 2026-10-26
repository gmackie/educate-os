import { describe, expect, it } from "vitest";
import { linkAction, pathOf, placeOf } from "./places.ts";

describe("places", () => {
  it("names each screen's route under its own prefix, and back", () => {
    const cases = [
      ["/", { app: "home" }],
      ["/admin", { app: "admin", hash: "#/" }],
      ["/admin/classes-people", { app: "admin", hash: "#/classes-people" }],
      ["/teach", { app: "teach", hash: "#/" }],
      ["/teach/classes/off_1/assignments/asg_2", { app: "teach", hash: "#/classes/off_1/assignments/asg_2" }],
      ["/learn", { app: "learn", path: "/" }],
      ["/learn/family/children/prn_3", { app: "learn", path: "/family/children/prn_3" }],
    ] as const;
    for (const [path, place] of cases) {
      expect(placeOf(path)).toStrictEqual(place);
      expect(pathOf(place)).toBe(path);
    }
  });

  it("treats a trailing slash as the same place, and anything unknown as home", () => {
    expect(placeOf("/admin/guardians/")).toStrictEqual({ app: "admin", hash: "#/guardians" });
    expect(placeOf("/administration")).toStrictEqual({ app: "home" });
    expect(pathOf({ app: "teach", hash: "" })).toBe("/teach");
  });
});

describe("links inside the frame", () => {
  it("moves a hash screen's route rather than the frame's hash", () => {
    expect(linkAction("#/classes", "admin")).toStrictEqual({ kind: "route", hash: "#/classes" });
    expect(linkAction("#/classes/off_1/roster", "teach")).toStrictEqual({ kind: "route", hash: "#/classes/off_1/roster" });
  });

  it("follows the district's own addresses for its screens to their places", () => {
    expect(linkAction("/teach/", "admin")).toStrictEqual({ kind: "place", path: "/teach" });
    expect(linkAction("/", "admin")).toStrictEqual({ kind: "place", path: "/learn" });
  });

  it("focuses a skip link's target instead of navigating to it", () => {
    expect(linkAction("#main", "learn")).toStrictEqual({ kind: "focus", id: "main" });
  });

  it("leaves the Learning Home's router links and downloads to the screen", () => {
    expect(linkAction("/grades", "learn")).toBeUndefined();
    expect(linkAction("data:text/csv;charset=utf-8,a", "teach")).toBeUndefined();
    expect(linkAction("blob:null/5f1", "learn")).toBeUndefined();
  });

  it("goes nowhere for anything that would take the frame away from the app", () => {
    expect(linkAction("/cdn-cgi/access/logout", "admin")).toStrictEqual({ kind: "none" });
    expect(linkAction("https://example.com/", "learn")).toStrictEqual({ kind: "none" });
    expect(linkAction("//evil.example/", "learn")).toStrictEqual({ kind: "none" });
  });
});
