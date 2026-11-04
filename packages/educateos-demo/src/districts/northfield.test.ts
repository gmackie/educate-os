import { beforeAll, describe, expect, it } from "vitest";
import { NORTHFIELD, NORTHFIELD_COURSE_CLASSES, NORTHFIELD_SHOWCASE } from "@educateos/fixtures";
import { bootNorthfield, NORTHFIELD_PERSONAS as PERSONAS, NORTHFIELD_SECTIONS } from "./northfield.ts";
import { schoolDayDue } from "@educateos/harness/school-day";

describe("the demo district", () => {
  let district: Awaited<ReturnType<typeof bootNorthfield>>;
  const as = (id: string) => district.clientFor(PERSONAS.find((p) => p.id === id)!.subject);
  beforeAll(async () => {
    const started = performance.now();
    district = await bootNorthfield();
    console.info(`Northfield booted, seeded and installed its courses in ${Math.round(performance.now() - started)} ms`);
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

  it("runs under an applied configuration, so the admin console shows the district set up and rostered", async () => {
    const { head } = await as("admin").call("admin.getConfig");
    expect(head?.desired).toMatchObject({ rostering: { provider: "oneroster-csv" }, modules: { "core-learning": { state: "enabled" } } });
  });

  it("gives the guardian both her children, in two schools", async () => {
    const children = await as("guardian").call("guardian.listChildren");
    expect(children.map((c) => c.displayName).toSorted()).toStrictEqual(["Lucía Delgado", "Mateo Delgado"]);
  });

  it("gives every class the rest of its semester from its sample course, with teacher-only notes kept from students", async () => {
    const library = await as("admin").call("admin.listLibraryCourses");
    for (const [packageId, offeringId] of Object.entries(NORTHFIELD_COURSE_CLASSES)) {
      expect(library.find((c) => c.packageId === packageId)?.publisher).toStrictEqual({ domain: "educateos.io", signed: true });
      const course = NORTHFIELD_SHOWCASE.courses.find((c) => c.offeringId === offeringId)!;
      const teacher = district.clientFor(NORTHFIELD.principals.find((p) => p.id === course.teacherId)!.externalIdentities[0]!.subject);
      const modules = (await teacher.call("teacher.listModules", { params: { offeringId } })).outline.modules;
      expect(modules.length, packageId).toBeGreaterThan(course.modules.length);
      expect(modules.slice(course.modules.length).every((m) => m.published && m.source?.kind === "course" && m.source.packageId === packageId), packageId).toBe(true);
    }
    const yazzie = as("k2-teacher"), mateo = as("k2-student");
    const params = { offeringId: "off_nf-g1read-fall-r7" };
    const modules = (await yazzie.call("teacher.listModules", { params })).outline.modules;
    expect(modules.map((m) => m.title)).toStrictEqual(["Short Vowel Sounds", "Stories We Love", "Two Letters, One Sound", "Magic E: Long Vowels", "Animal Facts", "Rhymes and Smooth Reading"]);
    expect(modules.slice(2).some((m) => m.items.some((i) => i.kind === "teacher-note"))).toBe(true);
    const seen = (await mateo.call("student.listModules", { params })).outline;
    expect(seen.modules.map((m) => m.title)).toStrictEqual(modules.map((m) => m.title));
    expect(seen.modules.flatMap((m) => m.items).some((i) => i.kind === "teacher-note")).toBe(false);
    expect(seen.modules.slice(2).every((m) => m.items.some((i) => i.kind === "page"))).toBe(true);
    const offered = (await yazzie.call("teacher.libraryCourses", { params })).find((c) => c.packageId === "educateos.io/grade-1-reading-foundations");
    expect(offered).toMatchObject({ matchesClass: true, installed: { version: "1.0.0", done: true } });
  });

  it("dues the showcase's work at 3:30 PM on a school day, never at the minute it booted", async () => {
    // The sample courses' activities are due as their course says, counted from their install.
    const showcase = new Set(NORTHFIELD_SHOWCASE.courses.find((c) => c.offeringId === "off_nf-eng9-fall-p3")!.activities.map((a) => a.title));
    const assignments = (await as("g912-teacher").call("teacher.listAssignments", { params: { offeringId: "off_nf-eng9-fall-p3" } })).filter((a) => showcase.has(a.title));
    expect(assignments.length).toBeGreaterThan(0);
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
