// SCHO-185: the routes that close the assignment and grade loop, each with who it refuses.
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "../src/index.ts";
import { bootDistrict, expectError, NF, RB, RIVERBEND, studentSubmitsEssay, teacherSetsUpEssay, type TestDistrict } from "./support.ts";

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const PDF = new TextEncoder().encode("%PDF-1.7\n% synthetic essay\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

async function courseWorkspace(district: TestDistrict, student: string) {
  return district.ok(student, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
}

describe("teacher.updateAssignment", () => {
  it("lets the class's teachers move the due date, stored in UTC and seen by students", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const updated = await district.ok(district.tokenFor(NF.rivera), "teacher.updateAssignment", {
      params: { assignmentId: assignment.id },
      body: { dueAt: "2026-11-20T17:00:00-05:00", latePolicy: { kind: "refuse" }, attemptsAllowed: 2 },
    });
    expect(updated).toMatchObject({ dueAt: "2026-11-20T22:00:00.000Z", latePolicy: { kind: "refuse" }, attemptsAllowed: 2, rubric: assignment.rubric });
    // A co-teacher manages the class's assignments too.
    await district.ok(district.tokenFor(NF.chen), "teacher.updateAssignment", { params: { assignmentId: assignment.id }, body: { title: "Later start argument" } });

    const [listed] = await district.ok(district.tokenFor(NF.amara), "student.listActivities", { params: { offeringId: NF.eng9 } });
    expect(listed!.assignment).toMatchObject({ dueAt: "2026-11-20T22:00:00.000Z", title: "Later start argument" });
  });

  it("refuses other classes' teachers, other districts, and an empty change", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const change = { params: { assignmentId: assignment.id }, body: { dueAt: "2026-12-01T00:00:00Z" } };
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.updateAssignment", change), 404, "not-found");
    // An administrator oversees the assignment but does not change it.
    expectError(await district.call(district.tokenFor(NF.admin), "teacher.updateAssignment", change), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.updateAssignment", change), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.rivera), "teacher.updateAssignment", { ...change, body: {} }), 400, "validation-failed");
    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.teacher), "teacher.updateAssignment", change), 404, "not-found");
  });
});

describe("student.withdrawSubmission", () => {
  it("withdraws the student's own submission before the due date, freeing the attempt", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const { receipt } = await studentSubmitsEssay(district, assignment.id);
    const amara = district.tokenFor(NF.amara);
    const withdrawn = await district.ok(amara, "student.withdrawSubmission", { params: { submissionId: receipt.submissionId } });
    expect(withdrawn).toMatchObject({ id: receipt.submissionId, withdrawnAt: expect.any(String) });
    expect(await district.ok(amara, "student.withdrawSubmission", { params: { submissionId: receipt.submissionId } })).toStrictEqual(withdrawn);
    // A withdrawn submission cannot be graded.
    expectError(await district.call(district.tokenFor(NF.rivera), "teacher.recordGrade", {
      params: { submissionId: receipt.submissionId },
      body: { score: { points: 1, maxPoints: 1 } },
    }), 409, "conflict");
  });

  it("refuses classmates, other districts, teachers, and anyone after the due date", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const { receipt } = await studentSubmitsEssay(district, assignment.id);
    const target = { params: { submissionId: receipt.submissionId } };
    expectError(await district.call(district.tokenFor(NF.elena), "student.withdrawSubmission", target), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.rivera), "student.withdrawSubmission", target), 403, "forbidden");
    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.student), "student.withdrawSubmission", target), 404, "not-found");

    await district.ok(district.tokenFor(NF.rivera), "teacher.updateAssignment", { params: { assignmentId: assignment.id }, body: { dueAt: "2026-09-15T00:00:00Z" } });
    expectError(await district.call(district.tokenFor(NF.amara), "student.withdrawSubmission", target), 403, "forbidden");
  });
});

describe("teacher.declineGradeProposal", () => {
  it("lets the lead teacher decline a co-teacher's proposal with a reason, which ends it", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const { receipt } = await studentSubmitsEssay(district, assignment.id);
    const chen = district.tokenFor(NF.chen);
    const rivera = district.tokenFor(NF.rivera);
    const proposed = await district.ok(chen, "teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 7, maxPoints: 10 } } });
    if (proposed.status !== "pending-approval") throw new Error("expected a proposal");
    const target = { params: { proposalId: proposed.proposal.id }, body: { reason: "The evidence criterion needs another read." } };

    // The co-teacher who proposed it cannot decide it; another class's teacher cannot see it.
    expectError(await district.call(chen, "teacher.declineGradeProposal", target), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.declineGradeProposal", target), 404, "not-found");
    expectError(await district.call(rivera, "teacher.declineGradeProposal", { ...target, body: { reason: "   " } }), 400, "validation-failed");
    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.teacher), "teacher.declineGradeProposal", target), 404, "not-found");

    const declined = await district.ok(rivera, "teacher.declineGradeProposal", target);
    expect(declined.declined).toMatchObject({ declinedBy: NF.rivera, reason: "The evidence criterion needs another read." });
    expect(await district.ok(rivera, "teacher.pendingGrades", { params: { assignmentId: assignment.id } })).toStrictEqual([]);
    expectError(await district.call(rivera, "teacher.approveGrade", { params: { proposalId: proposed.proposal.id } }), 409, "conflict");
    expect(await district.ok(district.tokenFor(NF.amara), "student.officialGrades", { params: { assignmentId: assignment.id } })).toStrictEqual([]);
  });
});

describe("starter material", () => {
  it("is published by the class's teacher and read by its enrolled students", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const rivera = district.tokenFor(NF.rivera);
    const material = await district.ok(rivera, "teacher.publishStarterMaterial", {
      params: { assignmentId: assignment.id },
      body: { title: "Essay outline", content: { kind: "text", mediaType: "text/markdown", text: "# Claim\n# Evidence\n# Counterclaim" } },
    });
    expect(material).toMatchObject({ assignmentId: assignment.id, title: "Essay outline", type: "document", publishedBy: NF.rivera });
    expect(material).not.toHaveProperty("content");
    const picture = await district.ok(rivera, "teacher.publishStarterMaterial", {
      params: { assignmentId: assignment.id },
      body: { title: "Model diagram", content: { kind: "bytes", mediaType: "image/png", base64: base64(PNG) } },
    });
    expect(picture.type).toBe("image");

    for (const student of [NF.amara, NF.elena]) {
      const token = district.tokenFor(student);
      const view = await district.ok(token, "student.getAssignment", { params: { assignmentId: assignment.id } });
      expect(view.starterMaterials.map((m) => m.title)).toStrictEqual(["Essay outline", "Model diagram"]);
      const read = await district.ok(token, "student.readStarterMaterial", { params: { assignmentId: assignment.id, materialId: material.id } });
      expect(read.content).toStrictEqual({ kind: "text", text: "# Claim\n# Evidence\n# Counterclaim" });
    }
    const image = await district.ok(district.tokenFor(NF.amara), "student.readStarterMaterial", { params: { assignmentId: assignment.id, materialId: picture.id } });
    expect(image.content).toStrictEqual({ kind: "bytes", base64: base64(PNG) });
    expect((await district.ok(rivera, "teacher.getAssignment", { params: { assignmentId: assignment.id } })).starterMaterials).toHaveLength(2);
  });

  it("is kept from students outside the class and published only by its teachers", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const body = { title: "Outline", content: { kind: "text" as const, mediaType: "text/plain", text: "Claim, evidence." } };
    const material = await district.ok(district.tokenFor(NF.rivera), "teacher.publishStarterMaterial", { params: { assignmentId: assignment.id }, body });
    const read = { params: { assignmentId: assignment.id, materialId: material.id } };
    // Dmitri was dropped from English 9; Chidi was never in it.
    expectError(await district.call(district.tokenFor(NF.dmitri), "student.readStarterMaterial", read), 404, "not-found");
    expectError(await district.call(district.tokenFor("prn_nf-student-chidi"), "student.getAssignment", { params: { assignmentId: assignment.id } }), 404, "not-found");
    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.student), "student.readStarterMaterial", read), 404, "not-found");

    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.publishStarterMaterial", { params: { assignmentId: assignment.id }, body }), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.admin), "teacher.publishStarterMaterial", { params: { assignmentId: assignment.id }, body }), 403, "forbidden");
    expectError(await riverbend.call(riverbend.tokenFor(RB.teacher), "teacher.publishStarterMaterial", { params: { assignmentId: assignment.id }, body }), 404, "not-found");
  });
});

describe("file uploads", () => {
  it("stores a PDF as bytes, which the teacher reads back exactly as submitted", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const amara = district.tokenFor(NF.amara);
    const workspace = await courseWorkspace(district, amara);
    const created = await district.ok(amara, "student.createArtifact", {
      body: { workspaceId: workspace.id, type: "document", title: "Essay.pdf", content: { kind: "bytes", mediaType: "application/pdf", base64: base64(PDF) } },
    });
    expect(created.head).toMatchObject({ mediaType: "application/pdf", sizeBytes: PDF.byteLength, content: { backend: "r2" } });
    const receipt = await district.ok(amara, "student.submit", {
      params: { assignmentId: assignment.id },
      body: { revisions: [{ artifactId: created.artifact.id, revisionId: created.head.id }] },
    });

    const submitted = await district.ok(district.tokenFor(NF.rivera), "teacher.submittedContent", {
      params: { submissionId: receipt.submissionId, artifactId: created.artifact.id },
    });
    expect(submitted.item.mediaType).toBe("application/pdf");
    expect(submitted.content).toStrictEqual({ kind: "bytes", base64: base64(PDF) });
    // A new revision may replace it with a picture of the work.
    const saved = await district.ok(amara, "student.saveRevision", {
      params: { artifactId: created.artifact.id },
      body: { content: { kind: "bytes", mediaType: "image/png", base64: base64(PNG) } },
    });
    expect(saved.head.mediaType).toBe("image/png");
  });

  it("refuses types off the allowlist, files that are not what they claim, and files over the limit", async () => {
    const district = await bootDistrict();
    const amara = district.tokenFor(NF.amara);
    const workspace = await courseWorkspace(district, amara);
    const upload = (content: unknown) =>
      district.call(amara, "student.createArtifact", { body: { workspaceId: workspace.id, type: "document", title: "Upload", content } as never });

    expectError(await upload({ kind: "bytes", mediaType: "image/gif", base64: base64(new TextEncoder().encode("GIF89a")) }), 400, "validation-failed");
    expectError(await upload({ kind: "bytes", mediaType: "application/x-msdownload", base64: base64(new Uint8Array([0x4d, 0x5a])) }), 400, "validation-failed");
    // An executable renamed to a PDF is refused by its contents.
    expectError(await upload({ kind: "bytes", mediaType: "application/pdf", base64: base64(new Uint8Array([0x4d, 0x5a, 0x90, 0x00])) }), 400, "validation-failed");
    expectError(await upload({ kind: "bytes", mediaType: "application/pdf", base64: "not base64!" }), 400, "validation-failed");
    const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    tooBig.set(PDF);
    expectError(await upload({ kind: "bytes", mediaType: "application/pdf", base64: base64(tooBig) }), 400, "validation-failed");
    expect(await district.ok(amara, "student.listArtifacts", { params: { workspaceId: workspace.id } })).toStrictEqual([]);
  });
});

describe("admin.listOfferings", () => {
  it("lists every class in the district, with its teachers and active student count", async () => {
    const district = await bootDistrict();
    const offerings = await district.ok(district.tokenFor(NF.admin), "admin.listOfferings");
    expect(offerings.map((o) => o.offering.id).toSorted()).toStrictEqual(district.directory.offerings.map((o) => o.id).toSorted());
    expect(offerings.find((o) => o.offering.id === NF.eng9)).toMatchObject({
      course: { title: "English 9" },
      teachers: ["Sam Rivera", expect.any(String)],
      // Dmitri was dropped.
      students: 2,
    });
  });

  it("is for district administrators only, and only their own district's classes", async () => {
    const district = await bootDistrict();
    expectError(await district.call(district.tokenFor(NF.rivera), "admin.listOfferings"), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.amara), "admin.listOfferings"), 403, "forbidden");
    const riverbend = await bootDistrict(RIVERBEND);
    const rbAdmin = RIVERBEND.roleAssignments.find((r) => r.role === "district-admin")!.principalId;
    const listed = await riverbend.ok(riverbend.tokenFor(rbAdmin), "admin.listOfferings");
    expect(listed.every((o) => o.offering.districtId === "dst_riverbend")).toBe(true);
    expect(listed.map((o) => o.offering.id)).not.toContain(NF.eng9);
  });
});
