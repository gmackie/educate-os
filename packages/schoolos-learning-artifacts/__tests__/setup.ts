import { expect } from "vitest";
import { DistrictId, OfferingId, PrincipalId, type Caller, type DistrictDirectorySnapshot, type PolicySettings } from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { NORTHFIELD } from "@schoolos/fixtures";
import { directoryPolicyInformation, PolicyEngine, type PolicyAuditEvent, type PolicyAuditSink } from "@schoolos/policy";
import { InMemoryWorkspaceStore, WorkspaceDirectory } from "@schoolos/workspaces";
import {
  artifactShareRelationships,
  BackendArtifactStore,
  InMemoryArtifactRecordStore,
  InMemoryInlineTextTable,
  InMemoryR2Bucket,
  LearningArtifacts,
  type NewArtifact,
} from "../src/index.ts";

/** Collects audit events in memory. */
class MemoryAuditSink implements PolicyAuditSink {
  readonly events: PolicyAuditEvent[] = [];

  async record(event: PolicyAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

export const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "shared-by-student",
  teacherObservation: "assigned-work-and-shared-conversations",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** The district's approved external document host. */
export const DOCS_HOST = "docs.northfield.example";

/** An artifact service over a fresh copy of `snapshot`, with the workspace directory that provisions its workspaces. */
export function setup(
  snapshot: DistrictDirectorySnapshot = NORTHFIELD,
  options: { floor?: PolicySettings; shares?: "wired" | "unwired" } = {},
) {
  const academics = InMemoryAcademicStore.seeded(snapshot);
  const workspaceStore = new InMemoryWorkspaceStore();
  const records = new InMemoryArtifactRecordStore();
  const audit = new MemoryAuditSink();
  const clock = { now: new Date("2026-10-20T12:00:00Z") };
  const floor = options.floor ?? FLOOR;
  const policy = new PolicyEngine({
    information: directoryPolicyInformation(
      academics,
      { effectivePolicy: async () => floor },
      options.shares === "wired" ? { relationships: [artifactShareRelationships(records)] } : {},
    ),
    audit,
  });
  const workspaces = new WorkspaceDirectory({
    workspaces: workspaceStore,
    directory: academics,
    policy,
    retention: { courseWorkspaceRetentionDays: 30 },
    now: () => clock.now,
  });
  const bucket = new InMemoryR2Bucket();
  const text = new InMemoryInlineTextTable();
  const artifacts = new LearningArtifacts({
    records,
    content: new BackendArtifactStore({ text, r2: bucket }),
    workspaces: workspaceStore,
    directory: academics,
    policy,
    approvedExternalHosts: [DOCS_HOST],
    now: () => clock.now,
  });

  /** Applies a change to the academic directory, as a roster sync or term transition would. */
  async function changeDirectory(change: (draft: DistrictDirectorySnapshot) => void) {
    const { snapshot: current, version } = await academics.load();
    change(current);
    await academics.commit(current, version);
  }

  return { artifacts, workspaces, records, bucket, text, audit, clock, changeDirectory };
}

/** An HTTP caller verified as `principalId`. */
export function as(principalId: string): Caller {
  return { principal: { principalId: PrincipalId.parse(principalId), districtId: DistrictId.parse("dst_northfield") }, channel: "http" };
}

/** Well-known callers. */
export const P = {
  morgan: as("prn_nf-morgan-lee"),
  rivera: as("prn_nf-teacher-rivera"),
  nfAdmin: as("prn_nf-district-admin"),
  amara: as("prn_nf-student-amara"),
  elena: as("prn_nf-student-elena"),
};

/** Well-known offerings. */
export const O = {
  bioFall: OfferingId.parse("off_nf-bio-fall-p2"),
};

/** A plain essay. */
export function essay(workspaceId: string, text: string, title = "Cell membranes essay"): NewArtifact {
  return {
    workspaceId: workspaceId as NewArtifact["workspaceId"],
    type: "document",
    title,
    content: { kind: "text", mediaType: "text/markdown", text },
    aiAssistance: { level: "none" },
  };
}

/** Expects a promise to reject with a SchoolOS error code. */
export async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}
