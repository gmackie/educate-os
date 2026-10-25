// H01 policy revocation: authority revoked mid-session is gone on the very next request. Each check
// keeps one client, so one token, across the revocation: nothing about the caller is cached.
import { expect } from "vitest";
import { bootHarness } from "@educateos/harness";
import { criterion } from "./gate.ts";
import {
  applyNorthfieldRoster,
  bootDistrictFor,
  bootPilot,
  expectDenied,
  NF,
  settleAiRequest,
  studentSubmitsEssay,
  teacherInstallsEssay,
} from "./support.ts";

const BOTH = { rivera: true, students: ["nf-s-2001", "nf-s-2004"] } as const;

/** A Northfield app whose English 9 class comes from the roster, so a roster import can revoke it. */
async function rosteredClass() {
  const [entry] = await bootHarness();
  const northfield = await bootDistrictFor(entry!);
  const { offeringId } = await applyNorthfieldRoster(northfield, BOTH);
  const installed = await teacherInstallsEssay(northfield, NF.rivera, offeringId);
  return { northfield, offeringId, ...installed };
}

/** A configuration document with the given AI spending setting. */
const aiSpending = (spending: "capped" | "disabled") => ({
  apiVersion: "educateos.io/v1alpha1",
  district: "dst_northfield",
  profile: "us-k12-conservative",
  identity: { provider: "district-sso" },
  rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
  modules: { "core-learning": "enabled", "learning-registry": "enabled", "content-studio": "enabled" },
  rollout: { target: "all-active-offerings", requiresAdminActivation: false },
  policies: { ai: { spending } },
});

criterion("h01.revocation", {
  enrollment: async () => {
    const { northfield, offeringId, assignment } = await rosteredClass();
    const { student, artifact } = await studentSubmitsEssay(northfield, NF.amara, offeringId, assignment.id);
    expect(await student.call("student.listActivities", { params: { offeringId } })).toHaveLength(1);
    expect((await settleAiRequest(northfield, NF.amara, offeringId, 1)).effect).toBe("allow");
    await student.call("student.saveRevision", { params: { artifactId: artifact.id }, body: { content: { kind: "text", mediaType: "text/plain", text: "before" } } });

    await applyNorthfieldRoster(northfield, { rivera: true, students: ["nf-s-2004"] });
    // The same client, with the same token, on the next request.
    await expectDenied(student.call("student.listActivities", { params: { offeringId } }));
    await expectDenied(student.call("student.saveRevision", { params: { artifactId: artifact.id }, body: { content: { kind: "text", mediaType: "text/plain", text: "after" } } }));
    await expectDenied(student.call("student.getActivity", { params: { activityId: assignment.activityId } }));
    expect((await student.call("me.get")).enrollments.map((e) => e.offeringId)).not.toContain(offeringId);
    expect(await settleAiRequest(northfield, NF.amara, offeringId, 1)).toMatchObject({ effect: "deny", reason: "not-enrolled" });
  },

  "teacher-role": async () => {
    const { northfield, offeringId, assignment, teacher } = await rosteredClass();
    const { receipt } = await studentSubmitsEssay(northfield, NF.amara, offeringId, assignment.id);
    expect(await teacher.call("teacher.roster", { params: { offeringId } })).not.toHaveLength(0);

    await applyNorthfieldRoster(northfield, { rivera: false, students: BOTH.students });
    await expectDenied(teacher.call("teacher.roster", { params: { offeringId } }));
    await expectDenied(teacher.call("teacher.getFeedback", { params: { submissionId: receipt.submissionId } }));
    await expectDenied(teacher.call("teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 1, maxPoints: 4 } } }));
    await expectDenied(teacher.call("teacher.runCi", { params: { submissionId: receipt.submissionId } }));
    expect(await teacher.call("teacher.listSubmissions", { params: { assignmentId: assignment.id } }).catch(() => [])).toStrictEqual([]);
    expect((await teacher.call("teacher.listOfferings")).map((o) => o.offering.id)).not.toContain(offeringId);
  },

  "policy-floor": async () => {
    const { northfield } = await bootPilot();
    const admin = await northfield.as(NF.admin);
    const capped = await admin.call("admin.applyConfig", { body: { document: aiSpending("capped"), acknowledgeApprovals: true } });
    expect((await settleAiRequest(northfield, NF.amara, NF.eng9, 1)).effect).toBe("allow");

    const disabled = await admin.call("admin.applyConfig", { body: { document: aiSpending("disabled"), expectedHeadRevisionId: capped.id, acknowledgeApprovals: true } });
    expect(await settleAiRequest(northfield, NF.amara, NF.eng9, 1)).toMatchObject({ effect: "deny", reason: "ai-spending-disabled" });
    expect(await settleAiRequest(northfield, NF.chidi, NF.math7, 1)).toMatchObject({ effect: "deny", reason: "ai-spending-disabled" });

    // Restoring it takes effect just as fast.
    await admin.call("admin.applyConfig", { body: { document: aiSpending("capped"), expectedHeadRevisionId: disabled.id, acknowledgeApprovals: true } });
    expect((await settleAiRequest(northfield, NF.amara, NF.eng9, 1)).effect).toBe("allow");
  },
});
