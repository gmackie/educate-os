import { describe, expect, it } from "vitest";
import { bootCedarValley } from "./cedarvalley.ts";
import { CEDARVALLEY_PERSONAS, CEDARVALLEY_PRINCIPALS } from "./cedarvalleyPersonas.ts";

const subjectOf = (id: string) => CEDARVALLEY_PERSONAS.find((p) => p.id === id)!.subject;

describe("Cedar Valley", () => {
  it("signs its personas in by the Clever user IDs its Clever district gives them", async () => {
    const district = await bootCedarValley();
    for (const persona of CEDARVALLEY_PERSONAS) {
      expect(persona.subject).toBe(district.clever.userId(CEDARVALLEY_PRINCIPALS[persona.id as keyof typeof CEDARVALLEY_PRINCIPALS]));
    }
  });

  it("boots unrostered: only its administrator can sign in until the visitor runs the Clever sync", async () => {
    const district = await bootCedarValley();
    expect(district.roster.synced()).toBe(false);
    const admin = district.clientFor(subjectOf("admin"));
    expect(await admin.call("me.get")).toMatchObject({ displayName: "Elaine Park" });
    expect(await admin.call("admin.listOfferings")).toEqual([]);
    expect(await admin.call("admin.rosterSyncStatus")).toMatchObject({ provider: "clever", runnable: true, runs: [] });
    await expect(district.clientFor(subjectOf("teacher")).call("me.get")).rejects.toMatchObject({ status: 401 });
    await expect(district.clientFor(subjectOf("student")).call("me.get")).rejects.toMatchObject({ status: 401 });
  });

  it("imports the whole Clever roster on the first sync, and its people sign in with work waiting", async () => {
    const district = await bootCedarValley();
    const result = await district.roster.sync();
    expect(result).toMatchObject({
      ran: true,
      // Elaine Park is on the roster too, and links to the local administrator rather than adding a second.
      run: { mode: "complete", outcome: "succeeded", counts: { offerings: { added: 4 }, principals: { added: 8 } } },
    });
    expect(district.roster.synced()).toBe(true);

    const admin = district.clientFor(subjectOf("admin"));
    const classes = await admin.call("admin.listOfferings");
    expect(classes.map(({ course, teachers, students }) => [course.title, teachers, students]).toSorted()).toEqual([
      ["Algebra I", ["Dana Whitaker"], 2],
      ["Earth Science 8", ["Dana Whitaker"], 3],
      ["English 8", ["Luis Ferreira"], 4],
      ["World History 7", ["Luis Ferreira"], 3],
    ]);
    const rosters = await Promise.all(classes.map(({ offering }) => admin.call("admin.offeringRoster", { params: { offeringId: offering.id } })));
    const students = new Set(rosters.flat().filter(({ enrollment }) => enrollment.role === "student").map(({ displayName }) => displayName));
    expect(students).toEqual(new Set(["An Nguyen", "Bao Nguyen", "Rowan Ellis", "Sofia Marquez", "Isaac Thornton", "Leila Farouk"]));

    for (const persona of CEDARVALLEY_PERSONAS) {
      expect(await district.clientFor(persona.subject).call("me.get")).toMatchObject({ displayName: persona.name });
    }
    const earthScience = classes.find(({ course }) => course.title === "Earth Science 8")!.offering.id;
    const student = district.clientFor(subjectOf("student"));
    expect((await student.call("student.listActivities", { params: { offeringId: earthScience } })).map((a) => a.assignment.title)).toEqual(["Where does the rain go?"]);
    const teacher = district.clientFor(subjectOf("teacher"));
    const [assignment] = await teacher.call("teacher.listAssignments", { params: { offeringId: earthScience } });
    expect(await teacher.call("teacher.listSubmissions", { params: { assignmentId: assignment!.id } })).toHaveLength(1);

    // A second sync finds nothing new, and seeds nothing twice.
    expect(await district.roster.sync()).toMatchObject({ ran: true, run: { outcome: "succeeded", counts: { principals: { added: 0 } } } });
    expect(await teacher.call("teacher.listAssignments", { params: { offeringId: earthScience } })).toHaveLength(1);
  });
});
