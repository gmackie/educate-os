import { describe, expect, it } from "vitest";
import { termClosedEvents } from "../src/index.ts";
import {
  bootDistrict,
  expectError,
  NF,
  northfieldConfig,
  recordAiRequest,
  rosterExport,
  studentSubmitsEssay,
  teacherSetsUpEssay,
} from "./support.ts";

describe("student journey (roadmap §3.3)", () => {
  it("signs in, opens an activity, saves an essay, submits, gets a receipt, and sees feedback only once released", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const amara = district.tokenFor(NF.amara);
    const rivera = district.tokenFor(NF.rivera);

    const me = await district.ok(amara, "me.get");
    expect(me).toMatchObject({ principalId: NF.amara, kind: "student", districtId: "dst_northfield" });
    expect(me.enrollments.map((e) => e.offeringId)).toContain(NF.eng9);

    const activities = await district.ok(amara, "student.listActivities", { params: { offeringId: NF.eng9 } });
    expect(activities).toHaveLength(1);
    expect(activities[0]!.activity.view).toBe("student");
    await district.ok(amara, "student.getActivity", { params: { activityId: assignment.activityId } });

    const { artifact, head, receipt } = await studentSubmitsEssay(district, assignment.id, amara);
    expect(receipt).toMatchObject({ assignmentId: assignment.id, studentPrincipalId: NF.amara, attempt: 1 });
    expect(receipt.items).toStrictEqual([{ artifactId: artifact.id, revisionId: head.id, digest: head.content.digest }]);

    const history = await district.ok(amara, "student.artifactHistory", { params: { artifactId: artifact.id } });
    expect(history.map((r) => r.number)).toStrictEqual([2, 1]);
    const first = await district.ok(amara, "student.getArtifact", { params: { artifactId: artifact.id }, query: { revisionId: history[1]!.id } });
    expect(first.content).toStrictEqual({ kind: "text", text: "School should start later. [1]" });

    const [submission] = await district.ok(amara, "student.listSubmissions", { params: { assignmentId: assignment.id } });
    expect(submission!.id).toBe(receipt.submissionId);
    expectError(await district.call(amara, "student.getFeedback", { params: { submissionId: receipt.submissionId } }), 404, "not-found");

    await district.ok(rivera, "teacher.runCi", { params: { submissionId: receipt.submissionId } });
    await district.ok(rivera, "teacher.addComment", { params: { submissionId: receipt.submissionId }, body: { body: "Strong claim; add a counterclaim." } });
    await district.ok(rivera, "teacher.releaseFeedback", { params: { submissionId: receipt.submissionId }, body: { state: "shared-with-student" } });

    const feedback = await district.ok(amara, "student.getFeedback", { params: { submissionId: receipt.submissionId } });
    expect(feedback.comments.map((c) => c.body)).toStrictEqual(["Strong claim; add a counterclaim."]);
    // The evaluator's suggestions are for the teacher alone.
    expect(feedback.scores).toStrictEqual([]);
  });

  it("keeps a personal workspace private to its owner and lists it with their course workspaces", async () => {
    const district = await bootDistrict();
    const amara = district.tokenFor(NF.amara);
    const personal = await district.ok(amara, "student.openPersonalWorkspace");
    const course = await district.ok(amara, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
    const mine = await district.ok(amara, "student.listWorkspaces");
    expect(mine.map((w) => w.id).toSorted()).toStrictEqual([personal.id, course.id].toSorted());
    expect(personal.storageHandle === undefined || personal.kind === "personal").toBe(true);
  });
});

describe("teacher journey (roadmap §3.2)", () => {
  it("imports a URL, approves it, creates and installs an activity, reviews submissions, runs CI and approves an official grade", async () => {
    const district = await bootDistrict();
    const rivera = district.tokenFor(NF.rivera);

    const offerings = await district.ok(rivera, "teacher.listOfferings");
    expect(offerings.map((o) => [o.offering.id, o.role])).toStrictEqual([[NF.eng9, "teacher"]]);
    const roster = await district.ok(rivera, "teacher.roster", { params: { offeringId: NF.eng9 } });
    expect(roster.map((r) => r.displayName)).toContain("Amara Okafor");

    const item = await district.ok(rivera, "teacher.importResource", { params: { offeringId: NF.eng9 }, body: { url: "https://open-lessons.example/osmosis-lab" } }) as { id: string };
    const queue = await district.ok(rivera, "teacher.reviewQueue", { params: { offeringId: NF.eng9 } }) as { itemId: string }[];
    expect(queue.map((entry) => entry.itemId)).toContain(item.id);

    const { assignment, installation, rubric } = await teacherSetsUpEssay(district, rivera);
    expect(installation.scope.offeringId).toBe(NF.eng9);
    expect(assignment).toMatchObject({ offeringId: NF.eng9, activityId: installation.id, rubric: { rubricId: "rbr_essay-basics", version: 1 } });
    expect(rubric.signature).toMatchObject({ signedBy: NF.rivera, channel: "http" });
    const releases = await district.ok(rivera, "teacher.listReleases", { params: { offeringId: NF.eng9 } });
    expect(releases).toHaveLength(1);
    expect((await district.ok(rivera, "teacher.listAssignments", { params: { offeringId: NF.eng9 } })).map((a) => a.id)).toStrictEqual([assignment.id]);

    const { receipt, artifact } = await studentSubmitsEssay(district, assignment.id);
    const submissions = await district.ok(rivera, "teacher.listSubmissions", { params: { assignmentId: assignment.id } });
    expect(submissions.map((s) => s.id)).toStrictEqual([receipt.submissionId]);
    const content = await district.ok(rivera, "teacher.submittedContent", { params: { submissionId: receipt.submissionId, artifactId: artifact.id } });
    expect(content.content).toMatchObject({ kind: "text" });

    const ci = await district.ok(rivera, "teacher.runCi", { params: { submissionId: receipt.submissionId } });
    expect(ci.run).toMatchObject({ view: "teacher", state: "completed", report: { key: { submissionDigest: receipt.submissionDigest } } });
    expect(ci.suggestions.map((s) => [s.criterionId, s.points, s.source])).toStrictEqual([
      ["length", 4, { kind: "suggested", suggester: { kind: "evaluator", evaluatorId: "writing.structure@1.0.0" } }],
      ["evidence", 4, { kind: "suggested", suggester: { kind: "evaluator", evaluatorId: "content.required@1.0.0" } }],
    ]);
    // Running it again returns the same run: the report depends on the work and rubric alone.
    const again = await district.ok(rivera, "teacher.runCi", { params: { submissionId: receipt.submissionId } });
    expect(again.run.runId).toBe(ci.run.runId);
    const feedback = await district.ok(rivera, "teacher.getFeedback", { params: { submissionId: receipt.submissionId } });
    expect(feedback.scores.every((s) => s.source.kind === "suggested")).toBe(true);
    expect(feedback.scores).toHaveLength(2);

    const graded = await district.ok(rivera, "teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 9, maxPoints: 10 } } });
    expect(graded.status).toBe("official");
    if (graded.status !== "official") return;
    expect(graded.version).toMatchObject({ version: 1, submissionDigest: receipt.submissionDigest, approval: { approvedBy: NF.rivera, channel: "http" } });
    const grades = await district.ok(district.tokenFor(NF.amara), "student.officialGrades", { params: { assignmentId: assignment.id } });
    expect(grades.map((g) => g.score)).toStrictEqual([{ points: 9, maxPoints: 10 }]);
  });

  it("sends a co-teacher's grade to the teacher for approval", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const { receipt } = await studentSubmitsEssay(district, assignment.id);
    const chen = district.tokenFor(NF.chen);
    const proposed = await district.ok(chen, "teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 7, maxPoints: 10 } } });
    expect(proposed.status).toBe("pending-approval");
    if (proposed.status !== "pending-approval") return;

    const rivera = district.tokenFor(NF.rivera);
    expect((await district.ok(rivera, "teacher.pendingGrades", { params: { assignmentId: assignment.id } })).map((p) => p.id)).toStrictEqual([proposed.proposal.id]);
    expectError(await district.call(chen, "teacher.approveGrade", { params: { proposalId: proposed.proposal.id } }), 403, "forbidden");
    const version = await district.ok(rivera, "teacher.approveGrade", { params: { proposalId: proposed.proposal.id } });
    expect(version).toMatchObject({ version: 1, proposal: { proposedBy: NF.chen } });
  });
});

describe("admin journey (roadmap §3.1)", () => {
  it("sees counts-only health, previews a roster import, plans and applies a config change, and reads the AI usage report", async () => {
    const district = await bootDistrict();
    const admin = district.tokenFor(NF.admin);

    const health = await district.ok(admin, "admin.health");
    expect(health).toMatchObject({ districtId: "dst_northfield", directory: { schools: 2, students: 5 }, work: { submissions: 0 } });

    const preview = await district.ok(admin, "admin.previewRoster", { body: { files: rosterExport() } }) as {
      canApply: boolean;
      changes: { principals: { added: string[] } };
      linked: { sourcedId: string; principalId: string }[];
    };
    expect(preview.changes.principals.added).toHaveLength(1);
    expect(preview.linked).toContainEqual({ sourcedId: "u-amara", principalId: NF.amara });
    // A preview changes nothing.
    expect((await district.ok(admin, "admin.health")).directory.students).toBe(5);

    const before = await district.ok(admin, "admin.getConfig");
    expect(before).toMatchObject({ revisions: 0, districtPolicy: { aiMonthlyCapCentsPerPrincipal: 200 } });
    const planned = await district.ok(admin, "admin.planConfig", { body: { document: northfieldConfig() } });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.installOrder).toContain("core-learning");
    const applied = await district.ok(admin, "admin.applyConfig", { body: { document: northfieldConfig(), acknowledgeApprovals: true } });
    expect(applied).toMatchObject({ id: planned.revision.id, status: "applied" });
    expect((await district.ok(admin, "admin.getConfig")).head?.id).toBe(applied.id);
    // Planning against a head that has moved on is refused.
    expectError(await district.call(admin, "admin.applyConfig", {
      body: { document: { ...northfieldConfig(), profile: "us-k12-standard" }, expectedHeadRevisionId: `cfg_${"0".repeat(32)}`, acknowledgeApprovals: true },
    }), 409, "conflict");

    const broken = await district.ok(admin, "admin.planConfig", { body: { document: { ...northfieldConfig(), apiVersion: "nope" } } });
    expect(broken.ok).toBe(false);

    await recordAiRequest(district, NF.amara, NF.eng9);
    const usage = await district.ok(admin, "admin.aiUsage") as { district: { requests: number; totalCents: number }; byOffering: Record<string, unknown> };
    expect(usage.district).toMatchObject({ requests: 1, totalCents: 2 });
    expect(Object.keys(usage.byOffering)).toStrictEqual([NF.eng9]);
    expect(JSON.stringify(usage)).not.toMatch(/prompt|text/i);

    const rollover = await district.ok(admin, "admin.termRollover", { params: { termId: NF.spring } }) as { canClose: boolean };
    expect(rollover.canClose).toBe(true);
  });

  it("applies a roster import, which reaches the directory and principal resolution on the next request", async () => {
    const district = await bootDistrict();
    const admin = district.tokenFor(NF.admin);
    const result = await district.ok(admin, "admin.applyRoster", { body: { files: rosterExport() } });
    expect(result.applied).toBe(true);
    const newcomer = district.idp.issue("nf-s-2099");
    const me = await district.ok(newcomer, "me.get");
    expect(me).toMatchObject({ kind: "student", displayName: "Robin Newcomer" });
  });

  it("closing a term hands the AI ledger a term-closed event, ending its course funding", async () => {
    const district = await bootDistrict();
    const admin = district.tokenFor(NF.admin);
    expect(await termClosedEvents(district.app.stores.workspaces, district.app.districtId)).toStrictEqual([]);
    const closed = await district.ok(admin, "admin.closeTerm", { params: { termId: NF.spring } });
    expect(closed.fundingCancellations).toBe(1);
    expect(await termClosedEvents(district.app.stores.workspaces, district.app.districtId)).toMatchObject([{ type: "term.closed", termId: NF.spring }]);
    await recordAiRequest(district, NF.amara, NF.eng9);
    const spring = await district.app.aiGovernor.beforeRequest({
      requestId: "req-spring",
      principal: { principalId: NF.amara, districtId: "dst_northfield" },
      workspace: { kind: "course", offeringId: NF.bioSpring },
      model: { provider: "cloudflare", modelId: "synthetic-model" },
      estimatedMaxCents: 5,
    });
    expect(spring).toMatchObject({ effect: "deny" });
  });
});
