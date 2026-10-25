import { expect } from "vitest";
import {
  ActivityId,
  DistrictId,
  OfferingId,
  PrincipalId,
  RubricId,
  type Caller,
  type DistrictDirectorySnapshot,
  type PolicySettings,
  type RequestChannel,
} from "@educateos/contracts";
import { InMemoryAcademicStore } from "@educateos/academics";
import type { SigningIdentity } from "@educateos/fleet";
import { NORTHFIELD } from "@educateos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@educateos/policy";
import { InMemoryWorkspaceStore, WorkspaceDirectory } from "@educateos/workspaces";
import {
  BackendArtifactStore,
  InMemoryArtifactRecordStore,
  InMemoryInlineTextTable,
  InMemoryR2Bucket,
  LearningArtifacts,
  type ArtifactView,
  type NewArtifact,
} from "@educateos/learning-artifacts";
import { AssessmentService, InMemoryAssessmentRecordStore, type NewAssignment, type SubmittedRevision } from "../src/index.ts";

const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "shared-by-student",
  teacherObservation: "assigned-work-and-shared-conversations",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** "Now" in every test, before the default due date. */
export const NOW = new Date("2026-10-20T12:00:00Z");
/** The default due date. */
export const DUE = "2026-10-25T23:59:00Z";

/** An assessment service over the learning artifacts and workspaces of a fresh copy of `snapshot`. */
export function setup(snapshot: DistrictDirectorySnapshot = NORTHFIELD, options: { receiptKey?: SigningIdentity } = {}) {
  const academics = InMemoryAcademicStore.seeded(snapshot);
  const workspaceStore = new InMemoryWorkspaceStore();
  const audit = new InMemoryPolicyAuditSink();
  const clock = { now: NOW };
  const now = () => clock.now;
  const policy = new PolicyEngine({
    information: directoryPolicyInformation(academics, { effectivePolicy: async () => FLOOR }),
    audit,
  });
  const workspaces = new WorkspaceDirectory({
    workspaces: workspaceStore,
    directory: academics,
    policy,
    retention: { courseWorkspaceRetentionDays: 30 },
    now,
  });
  const content = new BackendArtifactStore({ text: new InMemoryInlineTextTable(), r2: new InMemoryR2Bucket() });
  const artifactRecords = new InMemoryArtifactRecordStore();
  const artifacts = new LearningArtifacts({
    records: artifactRecords,
    content,
    workspaces: workspaceStore,
    directory: academics,
    policy,
    approvedExternalHosts: ["docs.northfield.example"],
    now,
  });
  const records = new InMemoryAssessmentRecordStore();
  const assessment = new AssessmentService({ records, artifacts, content, directory: academics, policy, now, ...options });

  /** Applies a change to the academic directory, as a roster sync or term transition would. */
  async function changeDirectory(change: (draft: DistrictDirectorySnapshot) => void) {
    const { snapshot: current, version } = await academics.load();
    change(current);
    await academics.commit(current, version);
  }

  return { assessment, artifacts, artifactRecords, workspaces, records, audit, clock, changeDirectory };
}

/** A caller verified as `principalId`, through `channel`. */
export function as(principalId: string, channel: RequestChannel = "http"): Caller {
  return { principal: { principalId: PrincipalId.parse(principalId), districtId: DistrictId.parse("dst_northfield") }, channel };
}

/** Well-known callers. */
export const P = {
  morgan: as("prn_nf-morgan-lee"),
  morganAgent: as("prn_nf-morgan-lee", "agent"),
  rivera: as("prn_nf-teacher-rivera"),
  chen: as("prn_nf-teacher-chen"),
  nfAdmin: as("prn_nf-district-admin"),
  amara: as("prn_nf-student-amara"),
  dmitri: as("prn_nf-student-dmitri"),
  elena: as("prn_nf-student-elena"),
  chidi: as("prn_nf-student-chidi"),
};

/** Well-known offerings. */
export const O = {
  bioFall: OfferingId.parse("off_nf-bio-fall-p2"), // Morgan teaches; Amara, Dmitri, Elena enrolled
  eng9: OfferingId.parse("off_nf-eng9-fall-p3"), // Rivera teaches, Chen co-teaches; Amara, Elena enrolled
};

/** A Biology essay assignment, with any settings overridden. */
export function essayAssignment(overrides: Partial<NewAssignment> = {}): NewAssignment {
  return {
    offeringId: O.bioFall,
    activityId: ActivityId.parse("act_cell-membrane-essay"),
    title: "Cell membranes essay",
    dueAt: DUE,
    latePolicy: { kind: "accept" },
    attemptsAllowed: 2,
    permittedArtifactTypes: ["document", "dataset"],
    rubric: { rubricId: RubricId.parse("rbr_bio-essay"), version: 1 },
    feedbackVisibility: "when-shared",
    ...overrides,
  };
}

/** A markdown document. */
export function doc(workspaceId: string, body: string, title = "Cell membranes essay"): NewArtifact {
  return {
    workspaceId: workspaceId as NewArtifact["workspaceId"],
    type: "document",
    title,
    content: { kind: "text", mediaType: "text/markdown", text: body },
    aiAssistance: { level: "none" },
  };
}

/** The revision to submit for an artifact's latest version. */
export function ref(view: ArtifactView): SubmittedRevision {
  return { artifactId: view.artifact.id, revisionId: view.head.id };
}

/** New text content for a revision. */
export function text(value: string) {
  return { content: { kind: "text", mediaType: "text/markdown", text: value } as const, aiAssistance: { level: "none" } as const };
}

/** Sets up an assignment and a student's essay in their Biology course workspace. */
export async function withEssay(student: Caller = P.amara, essayBody = "Membranes are selectively permeable.", overrides: Partial<NewAssignment> = {}) {
  const env = setup();
  const assignment = await env.assessment.createAssignment(P.morgan, essayAssignment(overrides));
  const workspace = await env.workspaces.ensureCourseWorkspace(student, O.bioFall);
  const essay = await env.artifacts.createArtifact(student, doc(workspace.id, essayBody));
  return { ...env, assignment, workspace, essay };
}

/** Expects a promise to reject with a EducateOS error code. */
export async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}
