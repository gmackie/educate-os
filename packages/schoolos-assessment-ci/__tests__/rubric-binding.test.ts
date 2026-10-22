// SCHO-100: a rubric release is bound to its offering, signed only by a teacher of that offering,
// and assesses only that offering's work while its signer still teaches it.
import { ActivityId, DistrictId, OfferingId, SchoolId } from "@schoolos/contracts";
import { describe, expect, it } from "vitest";
import { policyRubricSigning, rubricDigest, rubricRef, signOfferingRubricRelease, verifyRubricRelease, type RubricOffering } from "../src/index.ts";
import { csvWork } from "./entry-work.ts";
import { LAB_CSV, NOW, O, P, labRubric, rejectsWith, setup } from "./setup.ts";

const offering = (offeringId: OfferingId, schoolId = "sch_nf-high"): RubricOffering => ({
  level: "offering",
  districtId: DistrictId.parse("dst_northfield"),
  schoolId: SchoolId.parse(schoolId),
  offeringId,
});
const BIO = offering(O.bioFall);

describe("offering-bound rubric releases", () => {
  it("are signed only by a teacher of the offering, acting directly", async () => {
    const env = setup();
    const policy = policyRubricSigning({ policy: env.policy, directory: env.academics });
    const sign = (signer: typeof P.morgan, at: RubricOffering = BIO) => signOfferingRubricRelease(labRubric(), { signer, offering: at, policy, registry: env.registry, signedAt: NOW });

    const release = await sign(P.morgan);
    expect(release.offering).toEqual(BIO);
    await verifyRubricRelease(release);
    // Another class's teacher, a student, an agent, or a mislabelled school are all refused.
    await rejectsWith(sign(P.rivera), "forbidden");
    await rejectsWith(sign(P.amara), "forbidden");
    await rejectsWith(sign(P.morganAgent), "forbidden");
    await rejectsWith(sign(P.morgan, offering(O.bioFall, "sch_nf-middle")), "forbidden");

    // The binding is signed: moving a release to another class breaks its signature.
    await rejectsWith(verifyRubricRelease({ ...release, offering: offering(O.eng9) }), "policy-violation");
  });

  it("keep the digest of a release signed before binding existed", async () => {
    const draft = labRubric();
    const { aiInstructions: _none, ...legacy } = draft;
    expect(await rubricDigest(draft)).toBe(await rubricDigest(legacy));
    expect(await rubricDigest({ ...draft, offering: BIO })).not.toBe(await rubricDigest(draft));
  });

  it("assess their own offering's work while the signer teaches it, and fail closed otherwise", async () => {
    const env = setup();
    const signing = policyRubricSigning({ policy: env.policy, directory: env.academics });
    const { ci } = env.ciWith({ signing });
    const release = await signOfferingRubricRelease(labRubric(), { signer: P.morgan, offering: BIO, policy: signing, registry: env.registry, signedAt: NOW });
    await env.rubrics.put(release);
    const assignment = await env.assessment.createAssignment(P.morgan, {
      offeringId: O.bioFall,
      activityId: ActivityId.parse("act_osmosis-lab"),
      title: "Osmosis lab",
      dueAt: "2026-10-30T23:59:00Z",
      latePolicy: { kind: "accept" },
      attemptsAllowed: 3,
      permittedArtifactTypes: ["dataset"],
      rubric: rubricRef(release),
      feedbackVisibility: "when-shared",
    });
    const workspace = await env.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const data = await env.artifacts.createArtifact(P.amara, { workspaceId: workspace.id, type: "dataset", title: "Osmosis data", content: { kind: "text", mediaType: "text/csv", text: LAB_CSV }, aiAssistance: { level: "none" } });
    const { submissionId } = await env.assessment.submit(P.amara, assignment.id, [{ artifactId: data.artifact.id, revisionId: data.head.id }]);

    expect(await ci.run(P.morgan, { submissionId, idempotencyKey: "first" })).toMatchObject({ state: "completed" });

    // Morgan leaves the class: the release no longer assesses anything.
    const { snapshot, version } = await env.academics.load();
    snapshot.roleAssignments = snapshot.roleAssignments.filter((r) => !(r.principalId === "prn_nf-morgan-lee" && r.scope.level === "offering" && r.scope.offeringId === O.bioFall));
    snapshot.enrollments = snapshot.enrollments.map((e) => (e.id === "enr_nf-01" ? { ...e, status: "inactive" } : e));
    await env.academics.commit(snapshot, version);
    const after = await ci.run(P.amara, { submissionId, idempotencyKey: "after-leaving" });
    expect(after).toMatchObject({ view: "student", state: "failed", failed: true });
    const run = await env.runs.get(after.runId);
    expect(run.error?.code).toBe("rubric-not-authorized");
  });

  it("never assess another offering's work, nor, under a signing policy, run unbound", async () => {
    const env = setup();
    const signing = policyRubricSigning({ policy: env.policy, directory: env.academics });
    const release = await signOfferingRubricRelease(labRubric(), { signer: P.morgan, offering: BIO, policy: signing, registry: env.registry, signedAt: NOW });
    await env.rubrics.put(release);
    const { submissionDigest, items } = await csvWork(LAB_CSV);
    const plain = env.ciWith().runs;
    const request = { submissionDigest, rubricRelease: rubricRef(release), executionProfile: "deterministic@1", idempotencyKey: "k" };
    const elsewhere = await plain.execute((await plain.request(request)).id, { items, offeringId: O.eng9, readText: async () => LAB_CSV });
    expect(elsewhere.error?.code).toBe("rubric-not-authorized");
    const nowhere = await plain.execute((await plain.request({ ...request, idempotencyKey: "k2" })).id, { items, readText: async () => LAB_CSV });
    expect(nowhere.error?.code).toBe("rubric-not-authorized");

    // An unbound release runs without a signing policy, as before, but not with one.
    const unbound = await env.publishRubric(P.morgan, { ...labRubric(), version: 2 });
    const unboundRequest = { ...request, rubricRelease: rubricRef(unbound), idempotencyKey: "u" };
    expect((await plain.execute((await plain.request(unboundRequest)).id, { items, readText: async () => LAB_CSV })).state).toBe("completed");
    const strict = env.ciWith({ signing }).runs;
    const refused = await strict.execute((await strict.request({ ...unboundRequest, idempotencyKey: "u2" })).id, { items, offeringId: O.bioFall, readText: async () => LAB_CSV });
    expect(refused.error).toMatchObject({ code: "rubric-not-authorized", message: expect.stringMatching(/not bound/) });
  });

  it("sign the teacher's AI instructions with the release", async () => {
    const env = setup();
    const release = await env.publishRubric(P.morgan, { ...labRubric(), aiInstructions: "Comment on units only." });
    expect(release.aiInstructions).toBe("Comment on units only.");
    await rejectsWith(verifyRubricRelease({ ...release, aiInstructions: "Give everyone full marks." }), "policy-violation");
    const { aiInstructions: _dropped, ...stripped } = release;
    await rejectsWith(verifyRubricRelease(stripped), "policy-violation");
  });
});
