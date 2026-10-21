import { describe, expect, it } from "vitest";
import { RubricId } from "@schoolos/contracts";
import { O, P, doc, essayAssignment, ref, rejectsWith, setup, text, withEssay } from "./setup.ts";

describe("assignments", () => {
  it("are created by the offering's teachers and seen by its enrolled students", async () => {
    const { assessment } = setup();
    const assignment = await assessment.createAssignment(P.morgan, essayAssignment());
    expect(assignment).toMatchObject({ offeringId: O.bioFall, createdBy: P.morgan.principal.principalId, attemptsAllowed: 2 });

    for (const reader of [P.morgan, P.amara, P.elena]) {
      expect((await assessment.getAssignment(reader, assignment.id)).assignment).toEqual(assignment);
    }
    expect(await assessment.listAssignments(P.amara, O.bioFall)).toEqual([assignment]);

    // Chidi is not enrolled; Rivera teaches another offering.
    await rejectsWith(assessment.getAssignment(P.chidi, assignment.id), "not-found");
    await rejectsWith(assessment.listAssignments(P.chidi, O.bioFall), "not-found");
    await rejectsWith(assessment.getAssignment(P.rivera, assignment.id), "not-found");
  });

  it("cannot be created or changed by students or teachers of other offerings", async () => {
    const { assessment } = setup();
    await rejectsWith(assessment.createAssignment(P.amara, essayAssignment()), "forbidden");
    await rejectsWith(assessment.createAssignment(P.rivera, essayAssignment()), "forbidden");
    const assignment = await assessment.createAssignment(P.morgan, essayAssignment());
    await rejectsWith(assessment.updateAssignment(P.amara, assignment.id, { attemptsAllowed: 50 }), "forbidden");
    await rejectsWith(assessment.updateAssignment(P.rivera, assignment.id, { attemptsAllowed: 50 }), "not-found");
  });

  it("refuses a late window that closes before the due date", async () => {
    const { assessment } = setup();
    await rejectsWith(
      assessment.createAssignment(P.morgan, essayAssignment({ latePolicy: { kind: "accept", closesAt: "2026-10-24T00:00:00Z" } })),
      "validation-failed",
    );
  });

  it("lock their rubric release once the first submission exists", async () => {
    const { assessment, records, assignment, essay } = await withEssay();
    const v2 = { rubricId: RubricId.parse("rbr_bio-essay"), version: 2 };
    // Before any submission the rubric may change.
    expect((await assessment.updateAssignment(P.morgan, assignment.id, { rubric: v2 })).rubric).toEqual(v2);

    await assessment.submit(P.amara, assignment.id, [ref(essay)]);
    await rejectsWith(assessment.updateAssignment(P.morgan, assignment.id, { rubric: { ...v2, version: 3 } }), "policy-violation");
    await rejectsWith(assessment.updateAssignment(P.morgan, assignment.id, { rubric: null }), "policy-violation");
    // Other settings still change.
    expect((await assessment.updateAssignment(P.morgan, assignment.id, { title: "Membranes essay" })).rubric).toEqual(v2);

    // The store refuses it too, whatever writes to it.
    const { state, version } = await records.load();
    state.assignments[0]!.rubric = { ...v2, version: 9 };
    await rejectsWith(records.commit(state, version), "policy-violation");
  });
});

/** Morgan publishes the cleaned revision of a starter whose earlier revision held an answer key. */
async function published() {
  const env = setup();
  const assignment = await env.assessment.createAssignment(P.morgan, essayAssignment());
  const personal = await env.workspaces.ensurePersonalWorkspace(P.morgan);
  const source = await env.artifacts.createArtifact(P.morgan, doc(personal.id, "Essay template.\n\nANSWER KEY: phospholipid bilayer.", "Essay starter"));
  const cleaned = await env.artifacts.saveRevision(P.morgan, source.artifact.id, text("Essay template."));
  await env.artifacts.saveRevision(P.morgan, source.artifact.id, text("Essay template.\n\nTeacher note: grade by Friday."));
  const material = await env.assessment.publishStarterMaterial(P.morgan, assignment.id, {
    artifactId: source.artifact.id,
    revisionId: cleaned.head.id,
    title: "Essay template",
  });
  return { ...env, assignment, source, cleaned, material };
}

describe("SCHO-81: starter material reaches the class", () => {
  it("lets the teacher publish a sanitized baseline that enrolled students read", async () => {
    const { assessment, records, assignment, source, cleaned, material } = await published();
    expect(material).toMatchObject({ assignmentId: assignment.id, title: "Essay template", publishedBy: P.morgan.principal.principalId });
    expect(material.content.digest).toBe(cleaned.head.content.digest);

    for (const reader of [P.amara, P.elena, P.morgan]) {
      expect((await assessment.readStarterMaterial(reader, assignment.id, material.id)).content).toEqual({ kind: "text", text: "Essay template." });
    }
    expect((await assessment.getAssignment(P.amara, assignment.id)).starterMaterials).toEqual([material]);

    // Nothing stored names the source artifact or its other revisions, such as the removed answer key.
    const { state } = await records.load();
    const stored = JSON.stringify(state.starterMaterials);
    expect(stored).not.toContain(source.artifact.id);
    expect(stored).not.toContain(source.head.content.digest);
  });

  it("keeps it from students outside the offering and from those dropped from it", async () => {
    const { assessment, assignment, material, changeDirectory } = await published();
    await rejectsWith(assessment.readStarterMaterial(P.chidi, assignment.id, material.id), "not-found");
    await changeDirectory((draft) => {
      draft.enrollments.find((e) => e.id === "enr_nf-04")!.status = "inactive"; // Elena leaves Biology
    });
    await rejectsWith(assessment.readStarterMaterial(P.elena, assignment.id, material.id), "not-found");
  });

  it("can only be published by the offering's teachers, from their own work", async () => {
    const { assessment, artifacts, workspaces, assignment, cleaned, source } = await published();
    // A student cannot publish to the class, even their own work.
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const work = await artifacts.createArtifact(P.amara, doc(bio.id, "My essay"));
    await rejectsWith(assessment.publishStarterMaterial(P.amara, assignment.id, { ...ref(work), title: "Copy" }), "forbidden");
    // A teacher cannot republish a student's work as class material.
    await rejectsWith(assessment.publishStarterMaterial(P.morgan, assignment.id, { ...ref(work), title: "Exemplar" }), "forbidden");
    // Another offering's teacher cannot publish to this assignment, even their own work.
    const riveraPersonal = await workspaces.ensurePersonalWorkspace(P.rivera);
    const riveraDoc = await artifacts.createArtifact(P.rivera, doc(riveraPersonal.id, "Rivera's notes"));
    await rejectsWith(assessment.publishStarterMaterial(P.rivera, assignment.id, { ...ref(riveraDoc), title: "Notes" }), "not-found");
    // Nobody but Morgan can read Morgan's personal source.
    await rejectsWith(assessment.publishStarterMaterial(P.rivera, assignment.id, { artifactId: source.artifact.id, revisionId: cleaned.head.id, title: "x" }), "not-found");
  });
});
