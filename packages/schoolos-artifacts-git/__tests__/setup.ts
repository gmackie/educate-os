import { expect } from "vitest";
import { DistrictId, OfferingId, PrincipalId, type Caller, type DistrictDirectorySnapshot, type PolicySettings, type RequestChannel } from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { NORTHFIELD } from "@schoolos/fixtures";
import {
  BackendArtifactStore,
  InMemoryArtifactRecordStore,
  InMemoryInlineTextTable,
  InMemoryR2Bucket,
  LearningArtifacts,
} from "@schoolos/learning-artifacts";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@schoolos/policy";
import { InMemoryWorkspaceStore, WorkspaceDirectory } from "@schoolos/workspaces";
import {
  ArtifactsGitBackend,
  InMemoryArtifacts,
  InMemoryCredentialLedger,
  ProjectArtifacts,
  ProjectManifest,
  type NewProject,
  type WorkingTree,
} from "../src/index.ts";

const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "shared-by-student",
  teacherObservation: "assigned-work-and-shared-conversations",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/**
 * A project service over a fresh copy of `snapshot`. With `artifacts: false` the district's plan
 * has no Cloudflare Artifacts, so versions fall back to learning-artifacts' own storage. With
 * `provider: false`, learning-artifacts has no `artifacts-git` content provider registered, so Git
 * versions record their manifests as inline text, as a district app that has not registered it does.
 */
export function setup(options: { artifacts?: boolean; provider?: boolean; snapshot?: DistrictDirectorySnapshot } = {}) {
  const academics = InMemoryAcademicStore.seeded(options.snapshot ?? NORTHFIELD);
  const workspaceStore = new InMemoryWorkspaceStore();
  const clock = { now: new Date("2026-10-20T12:00:00Z") };
  const now = () => clock.now;
  const policy = new PolicyEngine({
    information: directoryPolicyInformation(academics, { effectivePolicy: async () => FLOOR }),
    audit: new InMemoryPolicyAuditSink(),
  });
  const workspaces = new WorkspaceDirectory({
    workspaces: workspaceStore,
    directory: academics,
    policy,
    retention: { courseWorkspaceRetentionDays: 30 },
    now,
  });
  const ledger = new InMemoryCredentialLedger();
  const storage = new InMemoryArtifacts({ now, isServiceToken: (tokenId) => ledger.holderOf(tokenId) === "service" });
  const git = new ArtifactsGitBackend({
    plan: options.artifacts === false ? undefined : { artifacts: storage, transport: storage },
    ledger,
  });
  const records = new InMemoryArtifactRecordStore();
  const text = new InMemoryInlineTextTable({ now });
  const bucket = new InMemoryR2Bucket({ now });
  const content = new BackendArtifactStore({ text, r2: bucket, providers: options.provider === false ? [] : [git.contentProvider] });
  const artifacts = new LearningArtifacts({
    records,
    content,
    workspaces: workspaceStore,
    directory: academics,
    policy,
    approvedExternalHosts: [],
    now,
  });
  const projects = new ProjectArtifacts({ artifacts, git, workspaces: workspaceStore, directory: academics, policy, now });

  /** Applies a change to the academic directory, as a term transition would. */
  async function changeDirectory(change: (draft: DistrictDirectorySnapshot) => void) {
    const { snapshot, version } = await academics.load();
    change(snapshot);
    await academics.commit(snapshot, version);
  }

  /** A version's manifest, read through learning-artifacts' content store whichever backend holds it. */
  async function manifestOf(revisionId: string): Promise<ProjectManifest> {
    const { state } = await records.load();
    const revision = state.revisions.find((r) => r.id === revisionId);
    if (revision === undefined) throw new Error(`no revision ${revisionId}`);
    return ProjectManifest.parse(JSON.parse(new TextDecoder().decode(await content.read(revision.content))));
  }

  return { projects, artifacts, workspaces, workspaceStore, git, storage, ledger, records, content, text, bucket, clock, changeDirectory, manifestOf };
}

/** A caller verified as `principalId`, through `channel`. */
export function as(principalId: string, channel: RequestChannel = "http"): Caller {
  return { principal: { principalId: PrincipalId.parse(principalId), districtId: DistrictId.parse("dst_northfield") }, channel };
}

/** Well-known callers: Morgan teaches biology, which Amara and Elena take. */
export const P = {
  morgan: as("prn_nf-morgan-lee"),
  amara: as("prn_nf-student-amara"),
  elena: as("prn_nf-student-elena"),
};

/** Well-known offerings. */
export const O = {
  bioFall: OfferingId.parse("off_nf-bio-fall-p2"),
};

/** A notebook project with `files`. */
export function notebook(workspaceId: string, files: WorkingTree, title = "Enzyme kinetics lab"): NewProject {
  return { workspaceId, type: "notebook", title, files, message: "First version", aiAssistance: { level: "none" } };
}

/** A save of `files`. */
export function saving(files: WorkingTree, message = "Update") {
  return { files, message, aiAssistance: { level: "none" } as const };
}

/** Expects a promise to reject with a SchoolOS error code. */
export async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

/** UTF-8 text as bytes. */
export function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}
