import { describe, expect, it } from "vitest";
import { createDistrictApp } from "../src/app.ts";
import { PrincipalId } from "@educateos/contracts";
import { digestJson, pinWorkshopAssessmentBlueprint, releaseAssessment } from "@educateos/assessment-sdk";
import { bootDistrict, importFetch, NF, teacherSetsUpEssay } from "./support.ts";

async function publicBlueprint(rubric: { rubricId: string; version: number; signature: { digest: string } }) {
  const definition = {
    format: "educateos.assessment.v1", id: "essay", version: "1.0.0", title: "Evidence essay", intent: "Support a claim with evidence.",
    outcomes: [{ id: "argument", description: "Make a supported argument" }],
    tasks: [{ id: "essay", kind: "writing", prompt: "Write an evidence-based essay.", evidence: [{ id: "essay", description: "Your essay", mediaTypes: ["text/markdown"], maxBytes: 10000 }], aiAssistance: { allowedUses: [], disclosureRequired: true } }],
    rubric: { id: rubric.rubricId, version: `${rubric.version}.0.0`, digest: rubric.signature.digest },
    evaluator: { id: "writing.structure", version: "1.0.0", digest: "sha256:" + "b".repeat(64) },
  };
  const files: [string, string][] = [["educateos.assessment.json", JSON.stringify(definition)], ["main.ts", "export default class Essay {}"]];
  const release = { commitId: "1".repeat(40), files, sourceDigest: await digestJson(files) };
  return { pin: await pinWorkshopAssessmentBlueprint("essay-blueprint", release), release };
}

async function setup(gadget = false) {
  const remote = { current: undefined as unknown, available: true };
  const district = await bootDistrict(undefined, { workshopReleases: { async getBlueprintRelease() {
    if (!remote.available) throw new Error("Unavailable");
    return remote.current;
  } } });
  const { assignment, rubric } = await teacherSetsUpEssay(district, undefined, gadget);
  const teacher = district.tokenFor(NF.rivera);
  const student = district.tokenFor(NF.amara);
  const subject = { districtId: district.app.districtId, principalId: PrincipalId.parse(NF.amara) };
  const published = await publicBlueprint(rubric);
  const blueprint = published.pin;
  remote.current = published.release;
  const params = { assignmentId: assignment.id };
  const workspace = await district.ok(student, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
  const artifact = await district.ok(student, "student.createArtifact", { body: {
    workspaceId: workspace.id, type: "document", title: "Essay from my Gadget",
    content: { kind: "text", mediaType: "text/markdown", text: "School should start later because sleep improves learning and supports wellbeing. [1]" },
  } });
  const request = { blueprint: blueprint.blueprint, revisions: [{ artifactId: artifact.artifact.id, revisionId: artifact.head.id }] };
  return { district, assignment, rubric, teacher, student, subject, blueprint, params, artifact, request, remote };
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
    expect((await s.district.call(s.teacher, "teacher.bindGadgetAssessment", { params: s.params, body: { blueprint: altered } })).status).toBe(503);
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

async function checkpointSetup() {
  const s = await setup(true);
  const definition = { ...s.blueprint.definition, tasks: [{
    id: "code", kind: "gadget" as const, prompt: "Submit your code; explain your work separately.",
    evidence: [{ id: "source", description: "Source checkpoint", mediaTypes: ["text/vnd.educateos.gadget-source+json"], maxBytes: 262144 }],
    aiAssistance: { allowedUses: [] as [], disclosureRequired: true },
  }] };
  const files: [string, string][] = [["educateos.assessment.json", JSON.stringify(definition)], ["server.js", "export default class Gadget {} // decomposed e\u0301"]];
  const release = { commitId: "1".repeat(40), files, sourceDigest: await digestJson(files) };
  s.remote.current = release;
  s.blueprint = await pinWorkshopAssessmentBlueprint("essay-blueprint", release);
  await s.district.ok(s.teacher, "teacher.updateAssignment", { params: s.params, body: { attemptsAllowed: 3 } });
  await s.district.ok(s.teacher, "teacher.bindGadgetAssessment", { params: s.params, body: { blueprint: s.blueprint } });
  const checkpoint = { format: "workshop.gadget-source.v1", policy: "educateos-source-v1", workspaceId: "workshop-owner-workspace", gadgetId: 1,
    commitId: "2".repeat(40), sourceDigest: release.sourceDigest, files, blueprint: { id: "essay-blueprint", commitId: release.commitId } };
  const input = { requestId: crypto.randomUUID(), blueprint: s.blueprint.blueprint, checkpoint };
  const submit = (body: unknown = input) => s.district.app.gadgetAssessmentSubmitCheckpoint(s.subject, s.assignment.id, body);
  return { ...s, input, submit };
}

describe("trusted source checkpoint to immutable district evidence", () => {
  it("stores exact source separately from authorship, retries across app restart and later submissions without consuming attempts", async () => {
    const s = await checkpointSetup();
    const first = await s.submit();
    expect(first.status, first.body).toBe(200);
    const receipt = JSON.parse(first.body);
    const submitted = await s.district.ok(s.teacher, "teacher.submittedContent", { params: { submissionId: receipt.submissionId, artifactId: receipt.items[0].artifactId } });
    expect(submitted.item.aiAssistance).toEqual({ level: "undisclosed" });
    expect(submitted.item.sourceCheckpoint?.commitId).toBe(s.input.checkpoint.commitId);
    const stored = await s.district.app.stores.artifactRecords.load();
    const revision = stored.state.revisions.find((r) => r.id === receipt.items[0].revisionId)!;
    const bytes = await s.district.app.stores.artifactContent.read(revision.content);
    const source = JSON.parse(new TextDecoder().decode(bytes));
    expect(source).toEqual(s.input.checkpoint);
    expect(source).not.toHaveProperty("chat");
    expect(source).not.toHaveProperty("bindings");
    const changed = structuredClone(s.input);
    changed.requestId = crypto.randomUUID();
    changed.checkpoint.commitId = "3".repeat(40);
    changed.checkpoint.files[1]![1] += "\n// another revision";
    changed.checkpoint.sourceDigest = await digestJson(changed.checkpoint.files);
    const second = await s.submit(changed);
    expect(second.status, second.body).toBe(200);
    expect(JSON.parse(second.body).attempt).toBe(2);
    const restarted = await createDistrictApp({ importFetch, stores: s.district.app.stores, verifyRequest: s.district.idp.verify,
      workshopReleases: { getBlueprintRelease: async () => s.remote.current } });
    expect(JSON.parse((await restarted.gadgetAssessmentSubmitCheckpoint(s.subject, s.assignment.id, s.input)).body)).toEqual(receipt);
    expect((await s.district.app.stores.artifactRecords.load()).state.artifacts).toHaveLength(stored.state.artifacts.length + 1);
    expect(await s.district.app.stores.artifactContent.read(revision.content)).toEqual(bytes);
    expect(await s.district.ok(s.student, "student.officialGrades", { params: s.params })).toEqual([]);
  }, 30_000);

  it("does not grant checkpoint provenance to student-authored lookalike JSON or MIME types", async () => {
    const s = await checkpointSetup();
    const workspace = await s.district.ok(s.student, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
    const fake = await s.district.ok(s.student, "student.createArtifact", { body: {
      workspaceId: workspace.id, type: "interactive", title: "Claimed checkpoint",
      content: { kind: "text", mediaType: "text/vnd.educateos.gadget-source+json", text: JSON.stringify(s.input.checkpoint) },
      aiAssistance: { level: "undisclosed" },
    } });
    const receipt = await s.district.ok(s.student, "student.submit", { params: s.params, body: {
      revisions: [{ artifactId: fake.artifact.id, revisionId: fake.head.id }],
    } });
    const content = await s.district.ok(s.teacher, "teacher.submittedContent", { params: {
      submissionId: receipt.submissionId, artifactId: fake.artifact.id,
    } });
    expect(content.item.sourceCheckpoint).toBeUndefined();
    expect(fake.head.provenance.sourceCheckpoint).toBeUndefined();
  }, 30_000);

  it("refuses altered request reuse, bad digest, wrong upstream, hidden extra fields and unsupported evidence before writing artifacts", async () => {
    const s = await checkpointSetup();
    const before = (await s.district.app.stores.artifactRecords.load()).state;
    for (const checkpoint of [
      { ...s.input.checkpoint, sourceDigest: "sha256:" + "f".repeat(64) },
      { ...s.input.checkpoint, blueprint: { ...s.input.checkpoint.blueprint, commitId: "f".repeat(40) } },
      { ...s.input.checkpoint, chat: "must never be exported" },
    ]) expect((await s.submit({ ...s.input, checkpoint })).status).toBeGreaterThanOrEqual(400);
    expect((await s.district.app.stores.artifactRecords.load()).state).toEqual(before);
    expect((await s.submit()).status).toBe(200);
    const changed = structuredClone(s.input);
    changed.checkpoint.commitId = "3".repeat(40);
    expect((await s.submit(changed)).status).toBe(409);
  }, 30_000);

  it("fails closed on remote outage or mutation and rechecks district/student/class, revocation and assignment limits after approval", async () => {
    const s = await checkpointSetup();
    const before = (await s.district.app.stores.artifactRecords.load()).state;
    s.remote.available = false;
    expect((await s.submit()).status).toBe(503);
    expect((await s.district.call(s.teacher, "teacher.getGadgetAssessment", { params: s.params })).status).toBe(503);
    s.remote.available = true;
    const release = s.remote.current;
    s.remote.current = { ...release as object, commitId: "f".repeat(40) };
    expect((await s.submit()).status).toBe(503);
    s.remote.current = release;
    for (const principal of [
      { ...s.subject, districtId: "dst_riverbend" as typeof s.subject.districtId },
      { ...s.subject, principalId: PrincipalId.parse(NF.dmitri) },
      { ...s.subject, principalId: PrincipalId.parse(NF.rivera) },
    ]) expect((await s.district.app.gadgetAssessmentSubmitCheckpoint(principal, s.assignment.id, s.input)).status).toBeGreaterThanOrEqual(400);
    expect((await s.district.app.stores.artifactRecords.load()).state).toEqual(before);
    await s.district.ok(s.teacher, "teacher.updateAssignment", { params: s.params, body: { attemptsAllowed: 1 } });
    expect((await s.submit()).status).toBe(200);
    const beforeRefusal = (await s.district.app.stores.artifactRecords.load()).state;
    expect((await s.submit({ ...s.input, requestId: crypto.randomUUID() })).status).toBe(403);
    expect((await s.district.app.stores.artifactRecords.load()).state).toEqual(beforeRefusal);
    const directory = await s.district.app.stores.directory.load();
    directory.snapshot.principals.find((p) => p.id === s.subject.principalId)!.status = "inactive";
    await s.district.app.stores.directory.commit(directory.snapshot, directory.version);
    expect((await s.submit()).status).toBe(401);
  }, 30_000);
});
