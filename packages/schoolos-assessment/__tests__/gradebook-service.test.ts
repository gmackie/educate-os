// SCHO-187: who reads and changes a gradebook, and what it is computed from.
import { describe, expect, it } from "vitest";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@schoolos/policy";
import type { DistrictDirectorySnapshot, OfferingId, PrincipalId } from "@schoolos/contracts";
import {
  DEFAULT_GRADEBOOK_SETTINGS,
  GradebookService,
  InMemoryAssessmentRecordStore,
  InMemoryGradebookStore,
  type AssessmentState,
  type AssignmentId,
  type GradebookGroupId,
} from "../src/index.ts";
import { as, NOW, P, rejectsWith } from "./setup.ts";

const BIO = "off_nf-bio-fall-p2" as OfferingId; // Morgan teaches; Amara, Dmitri, Elena enrolled
const ENG9 = "off_nf-eng9-fall-p3" as OfferingId; // Rivera teaches, Chen co-teaches
const BIO_SPRING = "off_nf-bio-spring-p4" as OfferingId; // completed term
const AMARA = "prn_nf-student-amara" as PrincipalId;
const ELENA = "prn_nf-student-elena" as PrincipalId;
const DMITRI = "prn_nf-student-dmitri" as PrincipalId;
const ESSAY = "asg_bio-essay" as AssignmentId;
const LAB = "asg_bio-lab" as AssignmentId;

const assignment = (id: string, offeringId: string, title: string, dueAt: string) => ({
  id, districtId: "dst_northfield", offeringId, activityId: "act_bio", title, dueAt, latePolicy: { kind: "accept" }, attemptsAllowed: 1,
  permittedArtifactTypes: ["document"], feedbackVisibility: "when-shared", createdBy: "prn_nf-morgan-lee", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
});
const version = (assignmentId: string, offeringId: string, student: string, points: number, n = 1) => ({
  format: "schoolos.official-grade.v1", districtId: "dst_northfield", offeringId, assignmentId, studentPrincipalId: student,
  submissionId: `sub_${assignmentId.slice(4)}-${student.slice(4)}`, submissionDigest: `sha256:${"b".repeat(64)}`, version: n,
  score: { points, maxPoints: 10 }, approval: { approvedBy: "prn_nf-morgan-lee", approvedAt: NOW.toISOString(), channel: "http" },
});

async function env(snapshot: DistrictDirectorySnapshot = NORTHFIELD) {
  const directory = InMemoryAcademicStore.seeded(snapshot);
  const audit = new InMemoryPolicyAuditSink();
  const policy = new PolicyEngine({
    information: directoryPolicyInformation(directory, {
      effectivePolicy: async () => ({
        aiSpending: "capped", promptsInGatewayLogs: "prohibited", studentPersonalConversations: "private",
        teacherObservation: "assigned-work-only", automatedSelProfiling: "prohibited", aiMonthlyCapCentsPerPrincipal: 500,
      }),
    }),
    audit,
  });
  const records = new InMemoryAssessmentRecordStore();
  const state = {
    assignments: [
      assignment(ESSAY, BIO, "Cell membranes essay", "2026-10-01T00:00:00.000Z"),
      assignment(LAB, BIO, "Osmosis lab", "2026-10-08T00:00:00.000Z"),
      assignment("asg_spring", BIO_SPRING, "Spring lab", "2026-03-01T00:00:00.000Z"),
    ],
    starterMaterials: [],
    submissions: [],
    feedback: [],
    gradeProposals: [{
      // A co-teacher's or agent's proposal, still waiting: it must never show in the gradebook.
      id: "gpr_waiting", assignmentId: LAB, studentPrincipalId: AMARA, submissionId: "sub_lab-amara", score: { points: 1, maxPoints: 10 },
      proposedBy: "prn_nf-morgan-lee", proposedVia: "agent", proposedAt: NOW.toISOString(),
    }],
    gradeVersions: [version(ESSAY, BIO, AMARA, 6, 1), version(ESSAY, BIO, AMARA, 8, 2), version(ESSAY, BIO, ELENA, 10)],
  } as unknown as AssessmentState;
  await records.commit(state, 0);
  const gradebooks = new InMemoryGradebookStore();
  const service = new GradebookService({ records, gradebooks, directory, policy, now: () => NOW });
  return { service, gradebooks, audit };
}

describe("the class grid", () => {
  it("shows the offering's teacher every actively enrolled student, from official grades only", async () => {
    const { service } = await env();
    const view = await service.grid(P.morgan, BIO);
    expect(view.columns.map((c) => c.assignmentId)).toStrictEqual([ESSAY, LAB]);
    expect(view.rows.map((r) => r.displayName)).toStrictEqual(["Amara Okafor", "Dmitri Novak", "Elena Sato"]);
    const amara = view.rows[0]!;
    expect(amara.cells.map((c) => c.score?.points)).toStrictEqual([8, undefined]);
    expect(amara.totals).toMatchObject({ unweighted: 80, letter: "B" });
    expect(view).toMatchObject({ revision: 0, settings: DEFAULT_GRADEBOOK_SETTINGS });
  });

  it("is read by co-teachers and administrators over the offering, and by no one else", async () => {
    const { service } = await env();
    expect((await service.grid(P.chen, ENG9)).rows.map((r) => r.studentPrincipalId)).toStrictEqual([AMARA, ELENA]);
    expect((await service.grid(P.nfAdmin, BIO)).rows).toHaveLength(3);
    await rejectsWith(service.grid(P.rivera, BIO), "not-found"); // another class's teacher
    await rejectsWith(service.grid(P.amara, BIO), "not-found"); // a student never reads the class grid
    await rejectsWith(service.grid(P.morgan, "off_rb-eng10-b" as OfferingId), "not-found"); // another district's offering
  });

  it("is refused to another district's principals", async () => {
    const { service } = await env(RIVERBEND);
    await rejectsWith(service.grid(as("prn_rb-teacher-haddad"), BIO), "not-found");
  });
});

describe("settings and markers", () => {
  const groups = (assignmentIds: AssignmentId[]) => [{ id: "grp_labs" as GradebookGroupId, name: "Labs", weight: 100, dropLowest: 0, assignmentIds }];

  it("are changed only by the offering's teacher, acting directly, over the revision they read", async () => {
    const { service } = await env();
    const settings = { ...DEFAULT_GRADEBOOK_SETTINGS, weighting: "group-weights" as const, groups: groups([LAB]) };
    const saved = await service.updateSettings(P.morgan, BIO, { revision: 0, settings });
    expect(saved).toMatchObject({ revision: 1, settings, updated: { by: "prn_nf-morgan-lee", at: NOW.toISOString() } });
    // Only the lab counts now, and nobody has a lab grade.
    expect(saved.rows[0]!.totals).toMatchObject({ weighted: null, final: null, unweighted: 80 });
    await rejectsWith(service.updateSettings(P.morgan, BIO, { revision: 0, settings }), "conflict");
    await rejectsWith(service.updateSettings(P.morgan, BIO, { revision: 1, settings: { ...settings, groups: groups(["asg_spring" as AssignmentId]) } }), "validation-failed");

    await rejectsWith(service.updateSettings(P.nfAdmin, BIO, { revision: 1, settings }), "forbidden");
    await rejectsWith(service.updateSettings(P.morganAgent, BIO, { revision: 1, settings }), "forbidden");
    await rejectsWith(service.updateSettings(P.chen, ENG9, { revision: 0, settings: DEFAULT_GRADEBOOK_SETTINGS }), "forbidden");
    await rejectsWith(service.updateSettings(P.rivera, BIO, { revision: 1, settings }), "not-found");
    await rejectsWith(service.updateSettings(P.amara, BIO, { revision: 1, settings }), "not-found");
  });

  it("mark a student's cell, recomputing their row, and only for the class's students and assignments", async () => {
    const { service, gradebooks } = await env();
    const row = await service.setMarker(P.morgan, BIO, { assignmentId: ESSAY, studentPrincipalId: DMITRI, marker: "missing" });
    expect(row.cells[0]).toMatchObject({ marker: "missing", counted: true, percent: 0 });
    expect(row.totals).toMatchObject({ points: { earned: 0, possible: 10 }, letter: "F" });
    expect((await gradebooks.load(BIO)).markers).toStrictEqual([{ assignmentId: ESSAY, studentPrincipalId: DMITRI, marker: "missing", setBy: "prn_nf-morgan-lee", setAt: NOW.toISOString() }]);
    // Before anyone has a lab grade there is nothing to say what the lab is out of, so it cannot count yet.
    expect((await service.setMarker(P.morgan, BIO, { assignmentId: LAB, studentPrincipalId: AMARA, marker: "missing" })).cells[1]).toMatchObject({ counted: false, percent: null });
    const cleared = await service.setMarker(P.morgan, BIO, { assignmentId: ESSAY, studentPrincipalId: DMITRI, marker: null });
    expect(cleared.cells[0]).not.toHaveProperty("marker");

    await rejectsWith(service.setMarker(P.morgan, BIO, { assignmentId: "asg_spring" as AssignmentId, studentPrincipalId: AMARA, marker: "late" }), "validation-failed");
    await rejectsWith(service.setMarker(P.morgan, BIO, { assignmentId: LAB, studentPrincipalId: "prn_nf-student-chidi" as PrincipalId, marker: "late" }), "validation-failed");
    await rejectsWith(service.setMarker(P.amara, BIO, { assignmentId: LAB, studentPrincipalId: AMARA, marker: "excused" }), "not-found");
  });

  it("freeze once the term completes", async () => {
    const { service } = await env();
    await rejectsWith(service.updateSettings(P.morgan, BIO_SPRING, { revision: 0, settings: DEFAULT_GRADEBOOK_SETTINGS }), "forbidden");
    expect((await service.grid(P.morgan, BIO_SPRING)).columns).toHaveLength(1);
  });
});

describe("CSV export", () => {
  it("is for the class's teachers, not administrators or students", async () => {
    const { service } = await env();
    const exported = await service.exportCsv(P.morgan, BIO);
    expect(exported.fileName).toBe("biology-i-period-2-gradebook.csv");
    expect(exported.csv.split("\r\n")[1]).toBe("Amara Okafor,prn_nf-student-amara,8,,8,10,80.00,,80.00,B");
    await rejectsWith(service.exportCsv(P.nfAdmin, BIO), "forbidden");
    await rejectsWith(service.exportCsv(P.amara, BIO), "not-found");
  });
});

describe("a student's own summary", () => {
  it("is their row alone, also after they leave the class", async () => {
    const { service } = await env();
    const summary = await service.studentSummary(P.elena, BIO);
    expect(summary.row).toMatchObject({ studentPrincipalId: ELENA, totals: { unweighted: 100, letter: "A" } });
    expect(summary.columns).toHaveLength(2);
    // Dmitri was dropped from English 9; his own row there is still his.
    expect((await service.studentSummary(P.dmitri, ENG9)).row.studentPrincipalId).toBe("prn_nf-student-dmitri");
  });

  it("is refused for a class the student was never in, and to staff", async () => {
    const { service } = await env();
    await rejectsWith(service.studentSummary(P.chidi, BIO), "not-found");
    await rejectsWith(service.studentSummary(P.morgan, BIO), "not-found");
  });
});
