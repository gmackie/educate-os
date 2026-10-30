import { describe, expect, it } from "vitest";
import { PrincipalId } from "@educateos/contracts";
import { digestJson, pinWorkshopAssessmentBlueprint, releaseAssessment } from "@educateos/assessment-sdk";
import { bootDistrict, NF, teacherSetsUpEssay } from "./support.ts";

async function publicBlueprint(rubric: { rubricId: string; version: number; signature: { digest: string } }) {
  const definition = {
    format: "educateos.assessment.v1", id: "essay", version: "1.0.0", title: "Evidence essay", intent: "Support a claim with evidence.",
    outcomes: [{ id: "argument", description: "Make a supported argument" }],
    tasks: [{ id: "essay", kind: "writing", prompt: "Write an evidence-based essay.", evidence: [{ id: "essay", description: "Your essay", mediaTypes: ["text/markdown"], maxBytes: 10000 }], aiAssistance: { allowedUses: [], disclosureRequired: true } }],
    rubric: { id: rubric.rubricId, version: `${rubric.version}.0.0`, digest: rubric.signature.digest },
    evaluator: { id: "writing.structure", version: "1.0.0", digest: "sha256:" + "b".repeat(64) },
  };
  const files: [string, string][] = [["educateos.assessment.json", JSON.stringify(definition)], ["main.ts", "export default class Essay {}"]];
  return pinWorkshopAssessmentBlueprint("essay-blueprint", { commitId: "1".repeat(40), files, sourceDigest: await digestJson(files) });
}

async function setup() {
  const district = await bootDistrict();
  const { assignment, rubric } = await teacherSetsUpEssay(district);
  const teacher = district.tokenFor(NF.rivera);
  const student = district.tokenFor(NF.amara);
  const subject = { districtId: district.app.districtId, principalId: PrincipalId.parse(NF.amara) };
  const blueprint = await publicBlueprint(rubric);
  const params = { assignmentId: assignment.id };
  const workspace = await district.ok(student, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
  const artifact = await district.ok(student, "student.createArtifact", { body: {
    workspaceId: workspace.id, type: "document", title: "Essay from my Gadget",
    content: { kind: "text", mediaType: "text/markdown", text: "School should start later because sleep improves learning and supports wellbeing. [1]" },
  } });
  const request = { blueprint: blueprint.blueprint, revisions: [{ artifactId: artifact.artifact.id, revisionId: artifact.head.id }] };
  return { district, assignment, rubric, teacher, student, subject, blueprint, params, artifact, request };
}

describe("Gadget assessment district authority", () => {
  it("fails closed without a teacher pin, then submits owned revisions idempotently into the real CI and teacher workflow", async () => {
    const s = await setup();
    expect((await s.district.app.gadgetAssessmentRead(s.subject, s.assignment.id)).status).toBe(503);
    expect(await s.district.ok(s.teacher, "teacher.getGadgetAssessment", { params: s.params })).toBeNull();
    const binding = await s.district.ok(s.teacher, "teacher.bindGadgetAssessment", { params: s.params, body: { blueprint: s.blueprint } });
    expect(binding.rubric).toEqual({ rubricId: s.rubric.rubricId, version: s.rubric.version });
    const read = await s.district.app.gadgetAssessmentRead(s.subject, s.assignment.id);
    expect(JSON.parse(read.body)).toMatchObject({ blueprint: s.blueprint, submissions: [] });
    expect(read.body).not.toContain('"checks"');
    const first = await s.district.app.gadgetAssessmentSubmit(s.subject, s.assignment.id, s.request);
    expect(first.status).toBe(200);
    const receipt = JSON.parse(first.body);
    const retry = await s.district.app.gadgetAssessmentSubmit(s.subject, s.assignment.id, s.request);
    expect(JSON.parse(retry.body)).toEqual(receipt);
    const ci = await s.district.ok(s.teacher, "teacher.runCi", { params: { submissionId: receipt.submissionId }, body: {} });
    expect(ci.run.state).toBe("completed");
    expect(ci.run.report).toBeDefined();
    expect(await s.district.ok(s.student, "student.officialGrades", { params: s.params })).toEqual([]);
    await s.district.ok(s.teacher, "teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 4, maxPoints: 8 } } });
    expect(await s.district.ok(s.student, "student.officialGrades", { params: s.params })).toHaveLength(1);
  }, 30_000);

  it("rejects principal/role/model escalation, cross-student artifacts, other classes/districts, and release substitution", async () => {
    const s = await setup();
    expect((await s.district.call(s.student, "teacher.bindGadgetAssessment", { params: s.params, body: { blueprint: s.blueprint } })).status).toBe(403);
    expect((await s.district.call(s.district.tokenFor(NF.morgan), "teacher.bindGadgetAssessment", { params: s.params, body: { blueprint: s.blueprint } })).status).toBe(404);
    await s.district.ok(s.teacher, "teacher.bindGadgetAssessment", { params: s.params, body: { blueprint: s.blueprint } });
    for (const extras of [{ principalId: NF.elena }, { role: "teacher" }, { model: "unapproved" }, { officialGrade: 100 }, { channel: "http" }]) {
      expect((await s.district.app.gadgetAssessmentSubmit(s.subject, s.assignment.id, { ...s.request, ...extras })).status).toBe(400);
    }
    const peer = { ...s.subject, principalId: PrincipalId.parse(NF.elena) };
    expect((await s.district.app.gadgetAssessmentSubmit(peer, s.assignment.id, s.request)).status).toBe(404);
    expect((await s.district.app.gadgetAssessmentRead({ ...s.subject, districtId: "dst_riverbend" as typeof s.subject.districtId }, s.assignment.id)).status).toBe(401);
    expect((await s.district.app.gadgetAssessmentRead({ ...s.subject, principalId: PrincipalId.parse(NF.rivera) }, s.assignment.id)).status).toBe(403);
    expect((await s.district.app.gadgetAssessmentRead({ ...s.subject, principalId: PrincipalId.parse(NF.dmitri) }, s.assignment.id)).status).toBe(404);
    expect((await s.district.app.gadgetAssessmentSubmit(s.subject, s.assignment.id, { ...s.request, blueprint: { ...s.request.blueprint, commitId: "f".repeat(40) } })).status).toBe(409);
    const altered = { ...s.blueprint, blueprint: { ...s.blueprint.blueprint, commitId: "f".repeat(40) } };
    expect((await s.district.call(s.teacher, "teacher.bindGadgetAssessment", { params: s.params, body: { blueprint: altered } })).status).toBe(409);
    const current = await s.district.ok(s.teacher, "teacher.getGadgetAssessment", { params: s.params });
    expect(current?.blueprint).toEqual(s.blueprint);
  }, 30_000);

  it("refuses a public rubric pin that does not match the assignment's signed CI release", async () => {
    const s = await setup();
    for (const rubric of [
      { ...s.blueprint.definition.rubric, id: "another-rubric" },
      { ...s.blueprint.definition.rubric, version: "2.0.0" },
      { ...s.blueprint.definition.rubric, digest: "sha256:" + "f".repeat(64) },
    ]) {
      const release = await releaseAssessment({ ...s.blueprint.definition, rubric });
      const blueprint = { ...s.blueprint, definition: release.definition, assessmentDigest: release.digest };
      expect((await s.district.call(s.teacher, "teacher.bindGadgetAssessment", { params: s.params, body: { blueprint } })).status).toBe(409);
    }
    expect((await s.district.call(s.teacher, "teacher.bindGadgetAssessment", { params: s.params, body: { blueprint: { ...s.blueprint, assessmentDigest: "sha256:" + "0".repeat(64) } } })).status).toBe(400);
    expect(await s.district.ok(s.teacher, "teacher.getGadgetAssessment", { params: s.params })).toBeNull();
  }, 30_000);

  it("rechecks revocation after a Gadget capability was opened", async () => {
    const s = await setup();
    await s.district.ok(s.teacher, "teacher.bindGadgetAssessment", { params: s.params, body: { blueprint: s.blueprint } });
    expect((await s.district.app.gadgetAssessmentRead(s.subject, s.assignment.id)).status).toBe(200);
    const stored = await s.district.app.stores.directory.load();
    const principal = stored.snapshot.principals.find((p) => p.id === s.subject.principalId)!;
    principal.status = "inactive";
    await s.district.app.stores.directory.commit(stored.snapshot, stored.version);
    expect((await s.district.app.gadgetAssessmentSubmit(s.subject, s.assignment.id, s.request)).status).toBe(401);
  }, 30_000);
});
