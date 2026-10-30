import { describe, expect, it } from "vitest";
import { bootCedarValley, type CedarValleyDistrict } from "../districts/cedarvalley.ts";
import { CEDARVALLEY_PERSONAS, CEDARVALLEY_PRINCIPALS } from "../districts/cedarvalleyPersonas.ts";
import { bootNorthfield } from "../districts/northfield.ts";
import { CleverSideStore, cleverSideOf } from "./cleverSide.ts";

/** The administrator, in a session as Cedar Valley's Clever sign-in would start one. */
const admin = (district: CedarValleyDistrict) => district.clientFor(district.sessions.start({
  issuer: district.cleverSso.issuer,
  subject: CEDARVALLEY_PERSONAS.find((p) => p.id === "admin")!.subject,
  credential: "person",
}));

/** Who is on each class's roster in the district now, as its students' names. */
async function districtRosters(district: CedarValleyDistrict): Promise<Record<string, string[]>> {
  const client = admin(district);
  const classes = await client.call("admin.listOfferings");
  const out: Record<string, string[]> = {};
  for (const { offering, course } of classes) {
    const roster = await client.call("admin.offeringRoster", { params: { offeringId: offering.id } });
    out[course.title] = roster.filter(({ enrollment }) => enrollment.role === "student" && enrollment.status === "active").map(({ displayName }) => displayName).toSorted();
  }
  return out;
}

const delta = (district: CedarValleyDistrict) => admin(district).call("admin.runRosterSync", { body: { mode: "delta" } });

describe("the Clever side", () => {
  it("waits for the district's first sync, then lists Clever's sections and their students", async () => {
    const district = await bootCedarValley();
    const side = new CleverSideStore(district.clever, district.roster);
    expect(side.getSnapshot().ready).toBe(false);
    await district.roster.sync();
    const { ready, sections } = side.getSnapshot();
    expect(ready).toBe(true);
    expect(sections.map((s) => [s.name, s.students.length])).toEqual([
      ["Algebra I - Whitaker", 2],
      ["Earth Science 8 - Whitaker", 3],
      ["English 8 - Ferreira", 4],
      ["World History 7 - Ferreira", 3],
    ]);
    // Moves stay within a school: Algebra I is at the high school.
    expect(side.moveTargets("prn_cv-student-bao", "off_cv-earthsci-p1").map((s) => s.name)).toEqual(["World History 7 - Ferreira"]);
    expect(side.moveTargets("prn_cv-student-isaac", "off_cv-alg1-p3")).toEqual([]);
  });

  it("withdraws a student in Clever, which a delta sync then deactivates, and only them", async () => {
    const district = await bootCedarValley();
    await district.roster.sync();
    const side = cleverSideOf(district)!;
    const change = side.withdraw("prn_cv-student-bao");
    expect(change.summary).toBe("Withdrew Bao Nguyen from the district");
    expect(change.events.map((e) => e.type)).toContain("users.deleted");
    expect(side.getSnapshot().pending).toEqual([change]);
    expect((await districtRosters(district))["Earth Science 8"]).toContain("Bao Nguyen");

    const result = await delta(district);
    expect(result.run).toMatchObject({ mode: "delta", outcome: "succeeded", counts: { principals: { added: 0, deactivated: 1 } } });
    expect(side.getSnapshot().pending).toEqual([]);
    expect(await districtRosters(district)).toEqual({
      "Algebra I": ["Isaac Thornton", "Leila Farouk"],
      "Earth Science 8": ["An Nguyen", "Rowan Ellis"],
      "English 8": ["An Nguyen", "Rowan Ellis", "Sofia Marquez"],
      "World History 7": ["An Nguyen", "Rowan Ellis", "Sofia Marquez"],
    });
  });

  it("adds a student to a section in Clever, whom a delta sync then brings in", async () => {
    const district = await bootCedarValley();
    await district.roster.sync();
    const side = cleverSideOf(district)!;
    const seen: string[] = [];
    side.onChange((c) => seen.push(c.summary));
    const change = side.addStudent("off_cv-alg1-p3");
    expect(seen).toEqual(["Added Maya Chen to Algebra I - Whitaker"]);
    expect(side.getSnapshot().sections.find((s) => s.id === "off_cv-alg1-p3")!.students.map((s) => s.name)).toContain("Maya Chen");

    const result = await delta(district);
    expect(result.run).toMatchObject({ outcome: "succeeded", counts: { principals: { added: 1, deactivated: 0 } } });
    expect((await districtRosters(district))["Algebra I"]).toEqual(["Isaac Thornton", "Leila Farouk", "Maya Chen"]);
    expect(side.getSnapshot().pending).toEqual([]);
    expect(change.change).toMatchObject({ kind: "added", student: { name: "Maya Chen" } });
  });

  it("moves a student between sections, which a delta sync applies as one enrollment ended and one begun", async () => {
    const district = await bootCedarValley();
    await district.roster.sync();
    const side = cleverSideOf(district)!;
    side.move("prn_cv-student-bao", "off_cv-earthsci-p1", "off_cv-whist7-p4");
    expect(side.getSnapshot().pending.map((p) => p.summary)).toEqual(["Moved Bao Nguyen from Earth Science 8 - Whitaker to World History 7 - Ferreira"]);
    expect(() => side.move("prn_cv-student-bao", "off_cv-earthsci-p1", "off_cv-whist7-p4")).toThrow(RangeError);

    const result = await delta(district);
    expect(result.run).toMatchObject({ outcome: "succeeded", counts: { principals: { added: 0, deactivated: 0 }, enrollments: { added: 1, deactivated: 1 } } });
    const rosters = await districtRosters(district);
    expect(rosters["Earth Science 8"]).not.toContain("Bao Nguyen");
    expect(rosters["World History 7"]).toContain("Bao Nguyen");
  });

  it("keeps changes pending through a failed sync, and keeps the demo's student", async () => {
    const district = await bootCedarValley();
    await district.roster.sync();
    // One store per district, shared by every persona, which keeps the demo's own student.
    const side = cleverSideOf(district)!;
    expect(cleverSideOf(district)).toBe(side);
    expect(cleverSideOf(await bootNorthfield())).toBeUndefined();
    expect(side.canWithdraw(CEDARVALLEY_PRINCIPALS.student)).toBe(false);
    expect(() => side.withdraw(CEDARVALLEY_PRINCIPALS.student)).toThrow(RangeError);
    side.addStudent("off_cv-eng8-p2");
    district.clever.inject({ kind: "outage", times: 50 });
    expect((await delta(district)).run).toMatchObject({ outcome: "failed" });
    expect(side.getSnapshot().pending).toHaveLength(1);
  });
});
