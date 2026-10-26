// H01 restore rehearsal, in memory: a working district is snapshotted through its stores' own
// interfaces, the app is discarded, and the snapshot is restored into fresh stores behind a new app.
// Everything the district's people can see over the API must be the same afterwards.
//
// What is restored, and how, is the rehearsal's real output: each store is read and written only
// through the interface a durable implementation will also have. Three stores offer no way to write
// back what they hold (the Content Studio's revisioned items, the catalog mirror's revisioned
// states, and the CI run store, which cannot be listed); the rehearsal re-creates or omits those and
// says so, and the durable rehearsal against D1 and R2 (SCHO-108) has to close that gap.
import { expect } from "vitest";
import { bootHarness } from "@educateos/harness";
import { restore, snapshot } from "./backup.ts";
import { criterion } from "./gate.ts";
import {
  applyNorthfieldRoster,
  approveCatalogSeeds,
  bootDistrictFor,
  NF,
  settleAiRequest,
  studentSubmitsEssay,
  teacherInstallsEssay,
  type PilotDistrict,
} from "./support.ts";

/** What each of a district's people sees of it over the API. */
async function viewsOf(district: PilotDistrict, offeringId: string, assignmentId: string, withFeedback: readonly string[]) {
  const admin = await district.as(NF.admin);
  const rivera = await district.as(NF.rivera);
  const views: Record<string, unknown> = {
    health: await admin.call("admin.health"),
    config: await admin.call("admin.getConfig"),
    usage: await admin.call("admin.aiUsage"),
    roster: await rivera.call("teacher.roster", { params: { offeringId } }),
    offerings: await rivera.call("teacher.listOfferings"),
    assignments: await rivera.call("teacher.listAssignments", { params: { offeringId } }),
    submissions: await rivera.call("teacher.listSubmissions", { params: { assignmentId } }),
  };
  for (const submissionId of withFeedback) views[`feedback ${submissionId}`] = await rivera.call("teacher.getFeedback", { params: { submissionId } });
  for (const studentId of [NF.amara, NF.elena]) {
    const student = await district.as(studentId);
    const workspaces = await student.call("student.listWorkspaces");
    views[`${studentId} me`] = await student.call("me.get");
    views[`${studentId} workspaces`] = workspaces;
    for (const workspace of workspaces) {
      for (const { artifact } of await student.call("student.listArtifacts", { params: { workspaceId: workspace.id } })) {
        const history = await student.call("student.artifactHistory", { params: { artifactId: artifact.id } });
        views[`${artifact.id} history`] = history;
        for (const revision of history) {
          views[`${artifact.id} ${revision.id}`] = await student.call("student.getArtifact", { params: { artifactId: artifact.id }, query: { revisionId: revision.id } });
        }
      }
    }
    views[`${studentId} activities`] = await student.call("student.listActivities", { params: { offeringId } });
    views[`${studentId} grades`] = await student.call("student.officialGrades", { params: { assignmentId } });
  }
  return views;
}

criterion("h01.restore", {
  "in-memory": async () => {
    const [entry] = await bootHarness();
    let original: PilotDistrict | undefined = await bootDistrictFor(entry!);
    // A district with a history: a roster import, a configuration, a class with work, grades and AI use.
    const { offeringId } = await applyNorthfieldRoster(original, { rivera: true, students: ["nf-s-2001", "nf-s-2004"] });
    const admin = await original.as(NF.admin);
    await admin.call("admin.applyConfig", {
      body: {
        document: {
          apiVersion: "educateos.io/v1alpha1", district: "dst_northfield", profile: "us-k12-conservative",
          identity: { provider: "district-sso" }, rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
          modules: { "core-learning": "enabled", "learning-registry": "enabled", "content-studio": "enabled" },
          rollout: { target: "all-active-offerings", requiresAdminActivation: false },
        },
        acknowledgeApprovals: true,
      },
    });
    const { teacher, assignment } = await teacherInstallsEssay(original, NF.rivera, offeringId);
    const amara = await studentSubmitsEssay(original, NF.amara, offeringId, assignment.id);
    await amara.student.call("student.saveRevision", { params: { artifactId: amara.artifact.id }, body: { content: { kind: "text", mediaType: "text/plain", text: "A later draft." } } });
    const personal = await amara.student.call("student.openPersonalWorkspace");
    await amara.student.call("student.createArtifact", { body: { workspaceId: personal.id, type: "document", title: "Journal", content: { kind: "text", mediaType: "text/plain", text: "Notes to myself." } } });
    const elena = await studentSubmitsEssay(original, NF.elena, offeringId, assignment.id, "Elena's essay argues the school day is fine as it is.");
    await teacher.call("teacher.runCi", { params: { submissionId: amara.receipt.submissionId } });
    await teacher.call("teacher.addComment", { params: { submissionId: amara.receipt.submissionId }, body: { body: "Good start." } });
    await teacher.call("teacher.releaseFeedback", { params: { submissionId: amara.receipt.submissionId }, body: { state: "shared-with-student" } });
    await teacher.call("teacher.recordGrade", { params: { submissionId: amara.receipt.submissionId }, body: { score: { points: 3, maxPoints: 4 } } });
    await settleAiRequest(original, NF.amara, offeringId, 4);
    await settleAiRequest(original, NF.elena, offeringId, 6);

    // Elena's submission has no feedback yet; an empty draft is computed on each read, so only stored feedback is compared.
    const withFeedback = [amara.receipt.submissionId];
    const before = await viewsOf(original, offeringId, assignment.id, withFeedback);
    expect((before.submissions as { id: string }[]).map((s) => s.id).toSorted()).toStrictEqual([amara.receipt.submissionId, elena.receipt.submissionId].toSorted());
    const backup = await snapshot(original.stores);
    original = undefined;

    const restoredStores = await restore(structuredClone(backup));
    const restored = await bootDistrictFor(entry!, { stores: restoredStores });
    // The catalog mirror cannot be written back through its interface, so its approved seeds are re-approved.
    await approveCatalogSeeds(restored.app, restored.directory);

    // The stores hold the same records...
    const after = await snapshot(restoredStores);
    expect(after.directory).toStrictEqual(backup.directory);
    expect([...after.artifactContent.keys()].toSorted()).toStrictEqual([...backup.artifactContent.keys()].toSorted());
    expect(after.artifactRecords).toStrictEqual(backup.artifactRecords);
    expect(after.assessment.submissions).toStrictEqual(backup.assessment.submissions);
    expect(after.ledger).toStrictEqual(backup.ledger);
    expect(after.config).toStrictEqual(backup.config);
    expect(after).toStrictEqual(backup);
    // ...and everyone sees the same district over the API.
    expect(await viewsOf(restored, offeringId, assignment.id, withFeedback)).toStrictEqual(before);
    // The restored district keeps working.
    const next = await studentSubmitsEssay(restored, NF.amara, offeringId, assignment.id, "A resubmission after the restore, long enough to pass.");
    expect(next.receipt.attempt).toBe(2);
  },
});
