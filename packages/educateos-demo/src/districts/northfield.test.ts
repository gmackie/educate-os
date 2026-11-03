import { beforeAll, describe, expect, it } from "vitest";
import { bootNorthfield, NORTHFIELD_PERSONAS as PERSONAS, NORTHFIELD_SECTIONS } from "./northfield.ts";
import { schoolDayDue } from "./schoolDay.ts";

describe("the demo district", () => {
  let district: Awaited<ReturnType<typeof bootNorthfield>>;
  const as = (id: string) => district.clientFor(PERSONAS.find((p) => p.id === id)!.subject);
  beforeAll(async () => {
    district = await bootNorthfield();
  }, 60_000);

  it("signs each persona in as who the picker says they are, a student and a teacher in each band", async () => {
    for (const persona of PERSONAS) {
      expect(await district.clientFor(persona.subject).call("me.get")).toMatchObject({ displayName: persona.name });
    }
    for (const band of ["K-2", "3-5", "6-8", "9-12"]) {
      expect(PERSONAS.filter((p) => p.section === band).map((p) => p.kind), band).toStrictEqual(["student", "teacher"]);
      expect(PERSONAS.find((p) => p.section === band && p.kind === "student")!.band).toBe(band);
    }
    expect(PERSONAS.every((p) => NORTHFIELD_SECTIONS.some((s) => s.key === p.section))).toBe(true);
  });

  it("seeds the showcase: Mateo has a story to retell and feedback to read, and his teacher work to review", async () => {
    const mateo = as("k2-student");
    const reading = await mateo.call("student.listActivities", { params: { offeringId: "off_nf-g1read-fall-r7" } });
    const retell = reading.find((a) => a.assignment.title === "Retell The Little Seed")!;
    expect(retell.activity.content.template).toBe("read-and-respond");
    expect(await mateo.call("student.listSubmissions", { params: { assignmentId: retell.assignment.id } })).toStrictEqual([]);
    const words = reading.find((a) => a.assignment.title === "Word Builders")!;
    expect(await mateo.call("student.assignmentFeedback", { params: { assignmentId: words.assignment.id } })).toHaveLength(1);

    const yazzie = as("k2-teacher");
    const submissions = await yazzie.call("teacher.listSubmissions", { params: { assignmentId: retell.assignment.id } });
    expect(submissions.flatMap((s) => s.items.map((i) => i.artifactType)).toSorted()).toEqual(["audio", "audio", "audio", "audio", "image", "image"]);
  });

  it("gives the guardian both her children, in two schools", async () => {
    const children = await as("guardian").call("guardian.listChildren");
    expect(children.map((c) => c.displayName).toSorted()).toStrictEqual(["Lucía Delgado", "Mateo Delgado"]);
  });

  it("dues work at 3:30 PM on a school day, never at the minute it booted", async () => {
    const assignments = await as("g912-teacher").call("teacher.listAssignments", { params: { offeringId: "off_nf-eng9-fall-p3" } });
    for (const { dueAt } of assignments) {
      const due = new Date(dueAt);
      expect([due.getHours(), due.getMinutes()]).toStrictEqual([15, 30]);
      expect([0, 6]).not.toContain(due.getDay());
    }
    // A Friday plus one day is the Monday after.
    const friday = new Date(2026, 10, 6, 9, 41);
    expect(new Date(schoolDayDue(friday)(1)).getDay()).toBe(1);
    expect(new Date(schoolDayDue(friday)(1)).getDate()).toBe(9);
  });

  it("answers someone the district does not know as signed in to no one", async () => {
    await expect(district.clientFor("nobody").call("me.get")).rejects.toMatchObject({ status: 401 });
  });

  it("carries a new submission through teacher review and released feedback without granting teacher access", async () => {
    const student = as("g912-student"), teacher = as("g912-teacher");
    const offeringId = "off_nf-eng9-fall-p3";
    const activity = (await student.call("student.listActivities", { params: { offeringId } }))
      .find((item) => item.assignment.title === "What Changes a Character?")!;
    const assignmentId = activity.assignment.id;
    const workspace = await student.call("student.openCourseWorkspace", { params: { offeringId } });
    const { artifact, head } = await student.call("student.createArtifact", { body: {
      workspaceId: workspace.id,
      type: "document",
      title: "What changes a character",
      content: { kind: "text", mediaType: "text/markdown", text: "Loss, not success, is what makes the narrator grow up." },
    } });
    await student.call("student.submit", { params: { assignmentId }, body: { revisions: [{ artifactId: artifact.id, revisionId: head.id }] } });
    const [own] = await student.call("student.listSubmissions", { params: { assignmentId } });
    expect((await teacher.call("teacher.listSubmissions", { params: { assignmentId } })).map((submission) => submission.id)).toContain(own!.id);
    await teacher.call("teacher.addComment", { params: { submissionId: own!.id }, body: { body: "A sharp claim. Now prove it with a quotation." } });
    await expect(student.call("student.getFeedback", { params: { submissionId: own!.id } })).rejects.toMatchObject({ status: 404 });
    await teacher.call("teacher.releaseFeedback", { params: { submissionId: own!.id }, body: { state: "shared-with-student" } });
    const feedback = await student.call("student.getFeedback", { params: { submissionId: own!.id } });
    expect(feedback.comments.map((comment) => comment.body)).toContain("A sharp claim. Now prove it with a quotation.");
    await expect(student.call("teacher.listSubmissions", { params: { assignmentId } })).rejects.toMatchObject({ status: 403 });
    await expect(as("guardian").call("guardian.childCourse", { params: { studentId: "prn_nf-student-amara", offeringId } })).rejects.toMatchObject({ status: 404 });
  });
});
