// Roadmap §3.4, the pilot exit criteria.
import { expect } from "vitest";
import { InstanceId, PrincipalId, SchoolId, type DistrictDirectorySnapshot } from "@educateos/contracts";
import { ResourceDescriptor } from "@educateos/registry";
import { DistrictAgent, InMemorySequenceCounter, SigningIdentity } from "@educateos/fleet";
import { createDistrictApiClient, type DistrictApiClient } from "@educateos/api-client";
import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import { bootDistrictApp, bootHarness, harnessFetch, seedDemo, type HarnessDistrict } from "@educateos/harness";
import { criterion } from "./gate.ts";
import { importThinCartridge } from "./cartridge.ts";
import { submitSyntheticBlueprint, SYNTHETIC_BLUEPRINT } from "./blueprint.ts";
import { entitlementWithRootDown } from "./root.ts";
import {
  applyNorthfieldRoster,
  bootDistrictFor,
  bootPilot,
  coursePool,
  expectDenied,
  expectRefused,
  NF,
  northfieldRoster,
  PilotClock,
  RB,
  settleAiRequest,
  studentSubmitsEssay,
  subjectOf,
  teacherInstallsEssay,
  centsOf,
  usdNano,
  type PilotDistrict,
} from "./support.ts";

/** A client for a harness district served exactly as `pnpm educateos:harness` serves it. */
async function harnessClient(entry: HarnessDistrict, fetch: (request: Request) => Promise<Response>, principalId: string): Promise<DistrictApiClient> {
  return createDistrictApiClient({
    baseUrl: "http://district.harness",
    token: await entry.identity.issueToken(subjectOf(entry.district.directory, principalId)),
    fetch,
  });
}

const activeOfferings = (directory: DistrictDirectorySnapshot) =>
  directory.offerings.filter((o) => directory.terms.find((t) => t.id === o.termId)?.state === "active");

criterion("x34.districts", {
  "two-districts": async () => {
    // The pilot criterion is about the two pilot districts, not every demo district the harness knows.
    const districts = await Promise.all((await bootHarness([NORTHFIELD, RIVERBEND])).map(async (entry) => {
      const app = await bootDistrictApp(entry);
      const demo = await seedDemo(entry, app);
      return { entry, app, demo, fetch: harnessFetch(entry, app) };
    }));
    expect(districts.map((d) => d.app.districtId)).toStrictEqual(["dst_northfield", "dst_riverbend"]);

    for (const { entry, demo, fetch } of districts) {
      const { directory } = entry.district;
      const admin = await harnessClient(entry, fetch, demo.admin.id);
      expect((await admin.call("admin.health")).directory.schools).toBeGreaterThanOrEqual(2);

      // Every writing, science and history class gets work from each of its active students.
      const submitters = new Set<string>();
      const subjects = new Set<string>();
      for (const offering of activeOfferings(directory)) {
        const subject = directory.courses.find((c) => c.id === offering.courseId)!.subject;
        if (!["english-language-arts", "science", "history-social-studies"].includes(subject)) continue;
        const students = directory.enrollments.filter((e) => e.offeringId === offering.id && e.role === "student" && e.status === "active");
        for (const enrollment of students) {
          const student = await harnessClient(entry, fetch, enrollment.principalId);
          const [assigned] = await student.call("student.listActivities", { params: { offeringId: offering.id } });
          expect(assigned, `${offering.id} has an activity`).toBeDefined();
          const { assignment } = assigned!;
          const already = await student.call("student.listSubmissions", { params: { assignmentId: assignment.id } });
          if (already.length === 0) {
            const workspace = await student.call("student.openCourseWorkspace", { params: { offeringId: offering.id } });
            const { artifact, head } = await student.call("student.createArtifact", {
              body: {
                workspaceId: workspace.id,
                type: assignment.permittedArtifactTypes[0]!,
                title: `Work for ${offering.sectionName}`,
                content: { kind: "text", mediaType: "text/markdown", text: `My ${subject} work, with enough words to count as a real attempt at it.` },
              },
            });
            await student.call("student.submit", { params: { assignmentId: assignment.id }, body: { revisions: [{ artifactId: artifact.id, revisionId: head.id }] } });
          }
          submitters.add(enrollment.principalId);
          subjects.add(subject);
        }
      }
      expect([...subjects].toSorted()).toStrictEqual(["english-language-arts", "history-social-studies", "science"]);
      expect(submitters.size).toBeGreaterThanOrEqual(2);
      expect((await admin.call("admin.health")).work.submissions).toBeGreaterThanOrEqual(submitters.size);
    }

    // Each district is its own instance: the other's tokens are refused.
    const [northfield, riverbend] = districts;
    const nfToken = await northfield!.entry.identity.issueToken(northfield!.demo.student.externalIdentities[0]!.subject);
    const rbFromNf = createDistrictApiClient({ baseUrl: "http://district.harness", token: nfToken, fetch: riverbend!.fetch });
    await expectRefused(rbFromNf.call("me.get"), 401, "unauthenticated");
  },
});

criterion("x34.unauthorized-reads", {
  "peer-work": async () => {
    const { northfield, riverbend } = await bootPilot();
    for (const [district, teacher, offering, owner, peer] of [
      [northfield, NF.rivera, NF.eng9, NF.amara, NF.elena],
      [riverbend, RB.haddad, RB.eng10, RB.kai, RB.lena],
    ] as const) {
      const { assignment, teacher: teacherApi } = await teacherInstallsEssay(district, teacher, offering);
      const { receipt, artifact } = await studentSubmitsEssay(district, owner, offering, assignment.id);
      await teacherApi.call("teacher.addComment", { params: { submissionId: receipt.submissionId }, body: { body: "Feedback for the owner only." } });
      await teacherApi.call("teacher.releaseFeedback", { params: { submissionId: receipt.submissionId }, body: { state: "shared-with-student" } });
      const other = await district.as(peer);
      await expectDenied(other.call("student.getArtifact", { params: { artifactId: artifact.id } }));
      await expectDenied(other.call("student.getFeedback", { params: { submissionId: receipt.submissionId } }));
      expect(await other.call("student.listSubmissions", { params: { assignmentId: assignment.id } })).toStrictEqual([]);
    }
  },

  "teacher-only": async () => {
    const [entry] = await bootHarness();
    const app = await bootDistrictApp(entry!);
    await seedDemo(entry!, app);
    const fetch = harnessFetch(entry!, app);
    const patel = await harnessClient(entry!, fetch, NF.patel);
    const [assignment] = await patel.call("teacher.listAssignments", { params: { offeringId: NF.math7 } });
    const teacherView = await patel.call("teacher.getActivity", { params: { activityId: assignment!.activityId } });
    expect(JSON.stringify(teacherView)).toContain("the constant is 3");
    expect(teacherView.content.codex.map((item) => item.visibility)).toContain("teacher-only");

    const chidi = await harnessClient(entry!, fetch, NF.chidi);
    const studentView = await chidi.call("student.getActivity", { params: { activityId: assignment!.activityId } });
    expect(studentView.view).toBe("student");
    expect(JSON.stringify(studentView)).not.toContain("the constant is 3");
    expect(studentView.content.codex.map((item) => item.visibility)).not.toContain("teacher-only");
    await expectRefused(chidi.call("teacher.getActivity", { params: { activityId: assignment!.activityId } }), 403, "forbidden");
    await expectRefused(chidi.call("teacher.listSubmissions", { params: { assignmentId: assignment!.id } }), 403, "forbidden");
  },

  "personal-workspace": async () => {
    const { northfield, riverbend } = await bootPilot();
    for (const [district, teacher, offering, student] of [
      [northfield, NF.rivera, NF.eng9, NF.amara],
      [riverbend, RB.haddad, RB.eng10, RB.kai],
    ] as const) {
      const owner = await district.as(student);
      const personal = await owner.call("student.openPersonalWorkspace");
      await owner.call("student.createArtifact", {
        body: { workspaceId: personal.id, type: "document", title: "Diary", content: { kind: "text", mediaType: "text/plain", text: "PERSONAL-ONLY" } },
      });
      const course = await owner.call("student.openCourseWorkspace", { params: { offeringId: offering } });
      const teacherApi = await district.as(teacher);
      expect((await teacherApi.call("teacher.listWorkspaces", { params: { offeringId: offering } })).map((w) => w.id)).toStrictEqual([course.id]);
      const refused = await expectRefused(teacherApi.call("teacher.listWorkspaceArtifacts", { params: { workspaceId: personal.id } }), 404, "not-found");
      expect(refused.message).not.toContain("PERSONAL-ONLY");
    }
  },
});

criterion("x34.content-sources", {
  url: async () => {
    const { northfield } = await bootPilot();
    const { release } = await teacherInstallsEssay(northfield, NF.rivera, NF.eng9);
    const descriptor = ResourceDescriptor.parse(release.descriptor);
    expect(descriptor.provenance).toBeDefined();
    expect(JSON.stringify(descriptor.locator)).toContain("open-lessons.example/persuasive-writing");
  },

  "thin-cc": async () => {
    const { northfield } = await bootPilot();
    const viaUrl = ResourceDescriptor.parse((await teacherInstallsEssay(northfield, NF.morgan, NF.bio, "https://open-lessons.example/persuasive-writing")).release.descriptor);

    const { record, importer, teacher } = await importThinCartridge(northfield, NF.morgan, NF.bio);
    const { item } = await importer.submitLinkForReview(teacher, record.id, record.links[0]!.id);
    // Review and approval are the class's ordinary queue, over the API.
    const morgan = await northfield.as(NF.morgan);
    const approved = await morgan.call("teacher.approveResource", { params: { itemId: item.id }, body: {} }) as { descriptor: unknown };
    const viaCartridge = ResourceDescriptor.parse(approved.descriptor);
    expect(Object.keys(viaCartridge).toSorted()).toStrictEqual(Object.keys(viaUrl).toSorted());
    expect(viaCartridge.kind).toBe(viaUrl.kind);
    expect(JSON.stringify(viaCartridge.locator)).toContain("open-lessons.example/osmosis-lab");
    // The cartridge's outline now places that release, by the same identifiers.
    const proposal = await importer.proposeCurriculum(teacher, record.id);
    expect(proposal.units.flatMap((unit) => unit.items)).toContainEqual({ kind: "resource", resourceId: viaCartridge.id, releaseVersion: viaCartridge.release.version });
    const releases = await morgan.call("teacher.listReleases", { params: { offeringId: NF.bio } }) as { descriptor: { id: string } }[];
    expect(releases.map((r) => r.descriptor.id).toSorted()).toStrictEqual([viaUrl.id, viaCartridge.id].toSorted());
  },

  blueprint: async () => {
    const { northfield } = await bootPilot();
    const viaUrl = ResourceDescriptor.parse((await teacherInstallsEssay(northfield, NF.morgan, NF.bio, "https://open-lessons.example/persuasive-writing")).release.descriptor);

    const { item, release } = await submitSyntheticBlueprint(northfield, NF.morgan, NF.bio);
    // The teacher reviews and approves it from the class's ordinary queue, over the API.
    const morgan = await northfield.as(NF.morgan);
    const queue = await morgan.call("teacher.reviewQueue", { params: { offeringId: NF.bio } }) as { itemId: string }[];
    expect(queue.map((entry) => entry.itemId)).toContain(item.id);
    const approved = await morgan.call("teacher.approveResource", { params: { itemId: item.id }, body: {} }) as { descriptor: unknown };
    const viaBlueprint = ResourceDescriptor.parse(approved.descriptor);
    expect(Object.keys(viaBlueprint).toSorted()).toStrictEqual(Object.keys(viaUrl).toSorted());
    expect(viaBlueprint).toMatchObject({
      kind: "interactive",
      locator: `urn:educateos:blueprint:${SYNTHETIC_BLUEPRINT.name}:release:${release.commitId}`,
      provenance: { sourceRevision: release.commitId },
      review: { status: "approved" },
    });
    // The release pins the commit; the gadget's code is in no registry record.
    expect(JSON.stringify(approved)).not.toContain("osmosis-explorer-client");
    const releases = await morgan.call("teacher.listReleases", { params: { offeringId: NF.bio } }) as { descriptor: { id: string } }[];
    expect(releases.map((r) => r.descriptor.id).toSorted()).toStrictEqual([viaUrl.id, viaBlueprint.id].toSorted());
  },
});

criterion("x34.submission-ci", {
  "snapshot-and-report": async () => {
    const { northfield } = await bootPilot();
    const { teacher, assignment } = await teacherInstallsEssay(northfield, NF.rivera, NF.eng9);
    const { student, artifact, head, receipt } = await studentSubmitsEssay(northfield, NF.amara, NF.eng9, assignment.id, "SUBMITTED-TEXT School should start later because sleep matters to learning.");

    // Editing after submitting changes the artifact, never the submission.
    await student.call("student.saveRevision", { params: { artifactId: artifact.id }, body: { content: { kind: "text", mediaType: "text/plain", text: "LATER-EDIT" } } });
    const submitted = await teacher.call("teacher.submittedContent", { params: { submissionId: receipt.submissionId, artifactId: artifact.id } });
    expect(submitted.item).toMatchObject({ revisionId: head.id, digest: head.content.digest });
    expect(JSON.stringify(submitted.content)).toContain("SUBMITTED-TEXT");
    expect(JSON.stringify(submitted.content)).not.toContain("LATER-EDIT");

    // The report depends on the pinned work and rubric alone: a fresh run reproduces it exactly.
    const first = await teacher.call("teacher.runCi", { params: { submissionId: receipt.submissionId } });
    const retry = await teacher.call("teacher.runCi", { params: { submissionId: receipt.submissionId } });
    const fresh = await teacher.call("teacher.runCi", { params: { submissionId: receipt.submissionId }, body: { idempotencyKey: "second-look" } });
    expect(first.run).toMatchObject({ state: "completed", report: { key: { submissionDigest: receipt.submissionDigest } } });
    expect(retry.run.runId).toBe(first.run.runId);
    expect(fresh.run.runId).not.toBe(first.run.runId);
    expect(fresh.run.report?.criteria).toStrictEqual(first.run.report?.criteria);
    expect(fresh.suggestions.map((s) => [s.criterionId, s.points])).toStrictEqual(first.suggestions.map((s) => [s.criterionId, s.points]));

    // Nothing is official until the teacher records it.
    expect(await student.call("student.officialGrades", { params: { assignmentId: assignment.id } })).toStrictEqual([]);
    const graded = await teacher.call("teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 4, maxPoints: 4 } } });
    expect(graded).toMatchObject({ status: "official", version: { submissionDigest: receipt.submissionDigest, approval: { approvedBy: NF.rivera } } });
  },
});

/** A configuration document exposing `modules` to `rollout`. */
function configDocument(rollout: Record<string, unknown>, modules: Record<string, string> = {}) {
  return {
    apiVersion: "educateos.io/v1alpha1",
    district: "dst_northfield",
    profile: "us-k12-conservative",
    identity: { provider: "district-sso" },
    rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
    modules: { "core-learning": "enabled", "learning-registry": "enabled", "content-studio": "enabled", ...modules },
    rollout,
  };
}

const ALL = { target: "all-active-offerings", requiresAdminActivation: false };
const TWO_CLASSES = { target: "selected-course-offerings", offerings: [NF.eng9, NF.bio], requiresAdminActivation: false };

criterion("x34.capability-subset", {
  predict: async () => {
    const { northfield } = await bootPilot();
    const admin = await northfield.as(NF.admin);
    const planned = await admin.call("admin.planConfig", { body: { document: configDocument(TWO_CLASSES, { "assessment-ci": "enabled" }) } });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { directory } = northfield;
    const active = (offeringId: string, kind: "student" | "staff") => new Set(directory.enrollments
      .filter((e) => e.offeringId === offeringId && e.status === "active" && (kind === "student") === (e.role === "student"))
      .map((e) => e.principalId)).size;
    expect(planned.plan.offerings.map((o) => [o.offeringId, o.students, o.staff]).toSorted()).toStrictEqual(
      [NF.bio, NF.eng9].map((id) => [id, active(id, "student"), active(id, "staff")]),
    );
    expect(planned.plan.offerings.every((o) => (o.packsExposed as string[]).includes("assessment-ci"))).toBe(true);
    // Planning changed nothing.
    expect(await admin.call("admin.getConfig")).toMatchObject({ revisions: 0 });
  },

  rollback: async () => {
    const { northfield } = await bootPilot();
    const admin = await northfield.as(NF.admin);
    const everywhere = await admin.call("admin.applyConfig", { body: { document: configDocument(ALL), acknowledgeApprovals: true } });
    const subset = await admin.call("admin.applyConfig", {
      body: { document: configDocument(TWO_CLASSES, { "assessment-ci": "enabled" }), expectedHeadRevisionId: everywhere.id, acknowledgeApprovals: true },
    });
    expect(subset.desired).not.toStrictEqual(everywhere.desired);
    // Rolling back is applying the earlier document again: a new, auditable revision of the earlier state.
    const rolledBack = await admin.call("admin.applyConfig", { body: { document: configDocument(ALL), expectedHeadRevisionId: subset.id, acknowledgeApprovals: true } });
    expect(rolledBack.id).not.toBe(everywhere.id);
    expect(rolledBack.desired).toStrictEqual(everywhere.desired);
    expect(rolledBack.previousRevisionId).toBe(subset.id);
    const config = await admin.call("admin.getConfig");
    expect(config).toMatchObject({ revisions: 3, head: { id: rolledBack.id } });
  },
});

criterion("x34.root-outage", {
  outage: async () => {
    const clock = new PilotClock(new Date().toISOString());
    const { northfield, riverbend } = await bootPilot();
    for (const [district, teacherId, offeringId, studentId] of [
      [northfield, NF.rivera, NF.eng9, NF.amara],
      [riverbend, RB.haddad, RB.eng10, RB.kai],
    ] as [PilotDistrict, string, string, string][]) {
      const start = Date.now();
      clock.set(new Date(start).toISOString());
      const { cache, rootDown } = await entitlementWithRootDown(district.app.districtId, clock.now);
      const { teacher, assignment } = await teacherInstallsEssay(district, teacherId, offeringId);
      // The root goes down for longer than the entitlement's validity and its grace.
      for (const daysLater of [1, 35, 50]) {
        clock.set(new Date(start + daysLater * 86_400_000).toISOString());
        const { outcome, evaluation } = await cache.refresh(rootDown);
        expect(outcome).toBe("root-unreachable");
        expect(evaluation.classroom).toBe("unaffected");
        const { receipt } = await studentSubmitsEssay(district, studentId, offeringId, assignment.id, `Essay written ${daysLater} days into the outage, which is long enough.`);
        expect((await teacher.call("teacher.listSubmissions", { params: { assignmentId: assignment.id } })).map((s) => s.id)).toContain(receipt.submissionId);
        await teacher.call("teacher.runCi", { params: { submissionId: receipt.submissionId } });
      }
      // Only root-managed changes stop once the entitlement lapses; the classroom never does.
      await expect(cache.evaluate()).resolves.toMatchObject({ state: "lapsed", rootManagedChanges: "blocked", classroom: "unaffected" });
    }
  },
});

criterion("x34.end-of-term", {
  retain: async () => {
    const clock = new PilotClock("2026-10-20T15:00:00Z");
    const [entry] = await bootHarness();
    const northfield = await bootDistrictFor(entry!, { now: clock.now });
    const roster = { rivera: true, students: ["nf-s-2001", "nf-s-2004"] } as const;
    const { offeringId, termId } = await applyNorthfieldRoster(northfield, roster);
    const { teacher, assignment } = await teacherInstallsEssay(northfield, NF.rivera, offeringId);
    const amara = await studentSubmitsEssay(northfield, NF.amara, offeringId, assignment.id);
    const elena = await studentSubmitsEssay(northfield, NF.elena, offeringId, assignment.id);
    const admin = await northfield.as(NF.admin);
    expect(await admin.call("admin.termRollover", { params: { termId } })).toMatchObject({ canClose: false });
    await expectRefused(admin.call("admin.closeTerm", { params: { termId } }), 409, "conflict");

    clock.set("2027-02-01T15:00:00Z");
    await applyNorthfieldRoster(northfield, roster);
    expect(await admin.call("admin.termRollover", { params: { termId } })).toMatchObject({ canClose: true });
    expect(await admin.call("admin.closeTerm", { params: { termId } })).toMatchObject({ retained: 2, grantsRevoked: 4 });

    // Every course grant of the term is revoked; every workspace, artifact and submission remains.
    const { state } = await northfield.stores.workspaces.load();
    expect(state.grants.filter((g) => g.termId === termId).every((g) => g.state === "revoked")).toBe(true);
    for (const { student, artifact, head, workspace } of [amara, elena]) {
      const listed = await student.call("student.listWorkspaces");
      expect(listed.find((w) => w.id === workspace.id)?.lifecycle).toMatch(/^(completed|retained)$/);
      expect((await student.call("student.getArtifact", { params: { artifactId: artifact.id } })).revision.id).toBe(head.id);
      await expectDenied(student.call("student.createArtifact", {
        body: { workspaceId: workspace.id, type: "document", title: "After the term", content: { kind: "text", mediaType: "text/plain", text: "x" } },
      }));
      await student.call("student.openPersonalWorkspace");
      expect(await student.call("student.keepArtifact", { params: { workspaceId: workspace.id, artifactId: artifact.id } })).toMatchObject({ artifactId: artifact.id });
    }
    expect((await teacher.call("teacher.listSubmissions", { params: { assignmentId: assignment.id } }))).toHaveLength(2);
  },
});

criterion("x34.metering", {
  accurate: async () => {
    const { northfield } = await bootPilot((directory) => ({
      fundingPools: [
        { ...coursePool(directory), id: "fpl_nf-high" as never, name: "High school course AI", scope: { level: "school", districtId: directory.district.id, schoolId: SchoolId.parse("sch_nf-high") } },
        { ...coursePool(directory), id: "fpl_nf-middle" as never, name: "Middle school course AI", scope: { level: "school", districtId: directory.district.id, schoolId: SchoolId.parse("sch_nf-middle") } },
      ],
    }));
    const settled: [string, string, number][] = [
      [NF.amara, NF.eng9, 3], [NF.amara, NF.bio, 5], [NF.elena, NF.eng9, 7], [NF.elena, NF.ushist, 11], [NF.chidi, NF.math7, 13], [NF.felix, NF.math7, 17],
    ];
    for (const [principal, offering, cents] of settled) expect((await settleAiRequest(northfield, principal, offering, cents)).effect).toBe("allow");
    // A denied request costs nothing.
    expect((await settleAiRequest(northfield, NF.dmitri, NF.bioSpring, 19)).effect).toBe("deny");

    const admin = await northfield.as(NF.admin);
    type Totals = { requests: number; totalUsdNano: string };
    const report = await admin.call("admin.aiUsage") as { district: Totals; byPrincipal: Record<string, Totals>; byOffering: Record<string, Totals>; byPool: Record<string, Totals> };
    const sum = (pick: (row: [string, string, number]) => string) => {
      const totals: Record<string, Totals> = {};
      for (const row of settled) {
        const key = pick(row);
        totals[key] = { requests: (totals[key]?.requests ?? 0) + 1, totalUsdNano: usdNano(centsOf(totals[key]?.totalUsdNano ?? "0") + row[2]) };
      }
      return totals;
    };
    const only = (rows: Record<string, Totals>) => Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { requests: v.requests, totalUsdNano: v.totalUsdNano }]));
    expect(report.district).toMatchObject({ requests: settled.length, totalUsdNano: usdNano(56) });
    expect(only(report.byPrincipal)).toStrictEqual(sum(([principal]) => principal));
    expect(only(report.byOffering)).toStrictEqual(sum(([, offering]) => offering));
    expect(only(report.byPool)).toStrictEqual(sum(([, offering]) => (offering === NF.math7 ? "fpl_nf-middle" : "fpl_nf-high")));
  },

  "no-root-content": async () => {
    const { northfield } = await bootPilot();
    await settleAiRequest(northfield, NF.amara, NF.eng9, 9);
    const { assignment } = await teacherInstallsEssay(northfield, NF.rivera, NF.eng9);
    await studentSubmitsEssay(northfield, NF.amara, NF.eng9, assignment.id, "ESSAY-CONTENT about sleep and school start times.");
    const agent = new DistrictAgent({
      identity: await SigningIdentity.generate(),
      instanceId: InstanceId.parse("ins_northfield"),
      sequence: new InMemorySequenceCounter(),
      sharesAggregateSpend: true,
    });
    const usage = await northfield.app.ledger.report();
    const heartbeat = await agent.heartbeat({ releaseVersion: "0.1.0", probes: [{ probeId: "district-app", status: "ok" }], aggregateAiSpendUsdNano: usage.district.totalUsdNano });
    const sent = JSON.stringify(heartbeat);
    expect(Object.keys(heartbeat.payload as object).toSorted()).toStrictEqual(["aggregateAiSpendUsdNano", "instanceId", "probes", "releaseVersion", "sentAt", "sequence"]);
    const { directory } = northfield;
    const personal = [
      ...directory.principals.flatMap((p) => [p.id, p.displayName, p.email ?? "", ...p.externalIdentities.map((x) => x.subject)]),
      ...directory.offerings.map((o) => o.id),
      "ESSAY-CONTENT",
    ].filter((value) => value !== "");
    for (const value of personal) expect(sent, value).not.toContain(value);
  },
});

criterion("x34.import-errors", {
  roster: async () => {
    const [entry] = await bootHarness();
    const northfield = await bootDistrictFor(entry!);
    const both = { rivera: true, students: ["nf-s-2001", "nf-s-2004"] } as const;
    const { offeringId } = await applyNorthfieldRoster(northfield, both);
    const { assignment } = await teacherInstallsEssay(northfield, NF.rivera, offeringId);
    const { workspace, artifact } = await studentSubmitsEssay(northfield, NF.amara, offeringId, assignment.id);
    const admin = await northfield.as(NF.admin);
    const directoryBefore = (await northfield.stores.directory.load()).snapshot;
    const workBefore = (await admin.call("admin.health")).work;

    // A feed with a broken row applies nothing.
    const files = northfieldRoster(both);
    files["enrollments.csv"] += "e-orphan,,,cls-missing,org-nf-high,u-nf-s-2001,student,,,\r\n";
    const refused = await admin.call("admin.applyRoster", { body: { files } });
    expect(refused.applied).toBe(false);

    // A second user claiming Amara's IdP subject is not linked to her, and she is not remapped.
    const impostor = await admin.call("admin.applyRoster", {
      body: { files: northfieldRoster({ ...both, students: [...both.students, "nf-s-2001"], extraStudents: [["nf-s-2001", "Mallory", "Impostor"]] }) },
    });
    expect(impostor.applied).toBe(false);

    expect((await northfield.stores.directory.load()).snapshot).toStrictEqual(directoryBefore);
    expect((await admin.call("admin.health")).work).toStrictEqual(workBefore);
    const amara = await northfield.as(NF.amara);
    expect(await amara.call("me.get")).toMatchObject({ principalId: NF.amara, displayName: "Amara Okafor" });
    expect((await amara.call("student.getArtifact", { params: { artifactId: artifact.id } })).artifact.workspaceId).toBe(workspace.id);
  },

  idp: async () => {
    const { northfield, riverbend } = await bootPilot();
    const subject = subjectOf(northfield.directory, NF.amara);
    const expired = await northfield.entry.identity.issueToken(subject, { ttlSeconds: -10 });
    await expectRefused(northfield.withToken(expired).call("me.get"), 401, "unauthenticated");
    const foreign = await riverbend.entry.identity.issueToken(subject);
    await expectRefused(northfield.withToken(foreign).call("me.get"), 401, "unauthenticated");
    const unknown = await northfield.entry.identity.issueToken("nf-s-9999");
    expect([401, 403]).toContain(await northfield.withToken(unknown).call("me.get").then(() => 200, (error: { status: number }) => error.status));
    const tampered = (await northfield.entry.identity.issueToken(subject)).split(".");
    const otherPayload = (await northfield.entry.identity.issueToken(subjectOf(northfield.directory, NF.admin))).split(".")[1]!;
    await expectRefused(northfield.withToken([tampered[0], otherPayload, tampered[2]].join(".")).call("me.get"), 401, "unauthenticated");
    // A good token still resolves to the same principal through all of it.
    expect((await (await northfield.as(NF.amara)).call("me.get")).principalId).toBe(PrincipalId.parse(NF.amara));
  },
});
