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

  it("carries a new student's submission through teacher review and released feedback without granting teacher access", async () => {
    const district = await bootDemoDistrict();
    const as = (id: string) => district.clientFor(PERSONAS.find((persona) => persona.id === id)!.subject);
    const student = as("student"), teacher = as("teacher"), guardian = as("guardian");
    const offeringId = "off_nf-eng9-fall-p3";
    const activity = (await student.call("student.listActivities", { params: { offeringId } }))
      .find((item) => item.assignment.title === "Reading reflection")!;
    const assignmentId = activity.assignment.id;
    const workspace = await student.call("student.openCourseWorkspace", { params: { offeringId } });
    const { artifact, head } = await student.call("student.createArtifact", { body: {
      workspaceId: workspace.id,
      type: "document",
      title: "Clever meeting reading reflection",
      content: { kind: "text", mediaType: "text/markdown", text: "I read an article about school gardens. Its evidence showed how observation can turn an everyday place into a science investigation." },
    } });
    const receipt = await student.call("student.submit", { params: { assignmentId }, body: { revisions: [{ artifactId: artifact.id, revisionId: head.id }] } });
    const [own] = await student.call("student.listSubmissions", { params: { assignmentId } });
    expect(receipt).toBeDefined();
    expect(own).toBeDefined();
    expect((await teacher.call("teacher.listSubmissions", { params: { assignmentId } })).map((submission) => submission.id)).toContain(own!.id);
    await teacher.call("teacher.addComment", { params: { submissionId: own!.id }, body: { body: "Clear reflection. Add one quotation to support the connection." } });
    await expect(student.call("student.getFeedback", { params: { submissionId: own!.id } })).rejects.toMatchObject({ status: 404 });
    const grade = await teacher.call("teacher.recordGrade", { params: { submissionId: own!.id }, body: { score: { points: 4, maxPoints: 5 } } });
    expect(grade.status).toBe("official");
    await teacher.call("teacher.releaseFeedback", { params: { submissionId: own!.id }, body: { state: "shared-with-student" } });
    const feedback = await student.call("student.getFeedback", { params: { submissionId: own!.id } });
    expect(feedback.comments.map((comment) => comment.body)).toContain("Clear reflection. Add one quotation to support the connection.");
    const course = await guardian.call("guardian.childCourse", { params: { studentId: "prn_nf-student-amara", offeringId } });
    expect(course.assignments.some((assignment) => assignment.assignment.id === assignmentId)).toBe(true);
    expect(course.assignments.find((assignment) => assignment.assignment.id === assignmentId)!.grades).toHaveLength(1);
    await expect(student.call("teacher.listSubmissions", { params: { assignmentId } })).rejects.toMatchObject({ status: 403 });
    await expect(guardian.call("guardian.childCourse", { params: { studentId: "prn_nf-student-elena", offeringId } })).rejects.toMatchObject({ status: 404 });
  });
});
