import { describe, expect, it } from "vitest";
import { bootDemoDistrict, PERSONAS } from "./demoDistrict.ts";

describe("the demo district", () => {
  it("signs each persona in as who the picker says they are, with work waiting for each", async () => {
    const district = await bootDemoDistrict();
    const as = (id: string) => district.clientFor(PERSONAS.find((p) => p.id === id)!.subject);
    for (const persona of PERSONAS) {
      expect(await district.clientFor(persona.subject).call("me.get")).toMatchObject({ displayName: persona.name });
    }

    const student = as("student");
    const [english] = (await student.call("me.get")).enrollments.filter((e) => e.offeringId === "off_nf-eng9-fall-p3");
    expect(english).toBeDefined();
    const activities = await student.call("student.listActivities", { params: { offeringId: "off_nf-eng9-fall-p3" } });
    expect(activities.map((a) => a.assignment.title).toSorted()).toEqual(["Reading reflection", "Should the school day start later?"]);

    const teacher = as("teacher");
    const assignments = await teacher.call("teacher.listAssignments", { params: { offeringId: "off_nf-eng9-fall-p3" } });
    const essay = assignments.find((a) => a.title === "Should the school day start later?")!;
    expect(await teacher.call("teacher.listSubmissions", { params: { assignmentId: essay.id } })).toHaveLength(2);

    expect(await as("guardian").call("guardian.listChildren")).toEqual([{ studentPrincipalId: "prn_nf-student-amara", displayName: "Amara Okafor" }]);
  });

  it("answers someone the district does not know as signed in to no one", async () => {
    const district = await bootDemoDistrict();
    await expect(district.clientFor("nobody").call("me.get")).rejects.toMatchObject({ status: 401 });
  });
});
