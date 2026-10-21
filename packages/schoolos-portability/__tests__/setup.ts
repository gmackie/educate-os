import { expect } from "vitest";
import {
  DistrictId,
  OfferingId,
  PrincipalId,
  SubmissionId,
  type Caller,
  type DistrictDirectorySnapshot,
  type PolicySettings,
} from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { NORTHFIELD } from "@schoolos/fixtures";
import {
  BackendArtifactStore,
  InMemoryArtifactRecordStore,
  InMemoryInlineTextTable,
  InMemoryR2Bucket,
  LearningArtifacts,
  sha256Digest,
  type NewArtifact,
} from "@schoolos/learning-artifacts";
import { DEFAULT_POLICY_RULES, directoryPolicyInformation, PolicyEngine, type PolicyRule } from "@schoolos/policy";
import { InMemoryWorkspaceStore, WorkspaceDirectory } from "@schoolos/workspaces";
import {
  canonicalJsonBytes,
  InMemoryExportMappingStore,
  readZip,
  StudentArchiveExporter,
  StudentArchiveManifest,
  writeZip,
  type FeedbackSourceRecord,
  type ResourceSourceRecord,
  type StudentRecordSource,
  type SubmissionSourceRecord,
  type ZipEntry,
} from "../src/index.ts";

const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "shared-by-student",
  teacherObservation: "assigned-work-and-shared-conversations",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** The district's approved external document host. */
export const DOCS_HOST = "docs.northfield.example";

/**
 * A rule some districts may add: learners export the published learning resources their work
 * cites. The v1 table has no such grant, so without it a cited resource is only ever a reference.
 */
export const RESOURCE_EXPORT_RULE: PolicyRule = {
  id: "district.resource.export",
  description: "Learners may export copies of published resources their work cites, where the resource's rights allow it.",
  when: { kinds: ["learning-resource"], actions: ["export"], classifications: ["public", "district-internal"] },
  effect: { effect: "allow" },
};

/**
 * A record source that returns every record it holds whoever asks, the way a buggy or compromised
 * source might. The exporter must still only take the learner's own.
 */
export class IndiscriminateRecordSource implements StudentRecordSource {
  readonly submissionRecords: SubmissionSourceRecord[] = [];
  readonly feedbackRecords: FeedbackSourceRecord[] = [];
  readonly resourceRecords: ResourceSourceRecord[] = [];
  readonly contents = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly contentReads: string[] = [];

  async submissions(): Promise<SubmissionSourceRecord[]> {
    return structuredClone(this.submissionRecords);
  }

  async feedback(): Promise<FeedbackSourceRecord[]> {
    return structuredClone(this.feedbackRecords);
  }

  async resources(): Promise<ResourceSourceRecord[]> {
    return structuredClone(this.resourceRecords);
  }

  async resourceContent(resourceId: string): Promise<Uint8Array<ArrayBuffer>> {
    this.contentReads.push(resourceId);
    const bytes = this.contents.get(resourceId);
    if (bytes === undefined) throw new Error(`no content for ${resourceId}`);
    return bytes.slice();
  }
}

/** The services an export runs over, on a fresh copy of `snapshot`. */
export function setup(options: {
  extraRules?: PolicyRule[];
  /** The whole rule table, in place of the defaults and `extraRules`. */
  rules?: PolicyRule[];
  /** The record source the exporter reads, in place of an {@link IndiscriminateRecordSource}. */
  source?: (academics: InMemoryAcademicStore) => StudentRecordSource;
  snapshot?: DistrictDirectorySnapshot;
  randomHex?: () => string;
} = {}) {
  const academics = InMemoryAcademicStore.seeded(options.snapshot ?? NORTHFIELD);
  const workspaceStore = new InMemoryWorkspaceStore();
  const clock = { now: new Date("2026-10-20T12:00:00Z") };
  const policy = new PolicyEngine({
    information: directoryPolicyInformation(academics, { effectivePolicy: async () => FLOOR }),
    audit: { record: async () => {} },
    rules: options.rules ?? [...(options.extraRules ?? []), ...DEFAULT_POLICY_RULES],
  });
  const workspaces = new WorkspaceDirectory({
    workspaces: workspaceStore,
    directory: academics,
    policy,
    retention: { courseWorkspaceRetentionDays: 30 },
    now: () => clock.now,
  });
  const artifacts = new LearningArtifacts({
    records: new InMemoryArtifactRecordStore(),
    content: new BackendArtifactStore({ text: new InMemoryInlineTextTable(), r2: new InMemoryR2Bucket() }),
    workspaces: workspaceStore,
    directory: academics,
    policy,
    approvedExternalHosts: [DOCS_HOST],
    now: () => clock.now,
  });
  const records = new IndiscriminateRecordSource();
  const mappings = new InMemoryExportMappingStore();
  const exporter = new StudentArchiveExporter({
    artifacts,
    workspaces,
    directory: academics,
    policy,
    records: options.source?.(academics) ?? records,
    mappings,
    now: () => clock.now,
    ...(options.randomHex === undefined ? {} : { randomHex: options.randomHex }),
  });

  /** Applies a change to the academic directory, as a roster sync or term transition would. */
  async function changeDirectory(change: (draft: DistrictDirectorySnapshot) => void) {
    const { snapshot: current, version } = await academics.load();
    change(current);
    await academics.commit(current, version);
  }

  /** Marks the Fall 2026 term completed, closing its courses. */
  async function completeFallTerm() {
    await changeDirectory((d) => {
      d.terms.find((t) => t.id === "trm_nf-2026-fall")!.state = "completed";
    });
  }

  return { academics, artifacts, workspaces, records, mappings, exporter, clock, changeDirectory, completeFallTerm };
}

/** An HTTP caller verified as `principalId`. */
export function as(principalId: string): Caller {
  return { principal: { principalId: PrincipalId.parse(principalId), districtId: DistrictId.parse("dst_northfield") }, channel: "http" };
}

/** Well-known callers. */
export const P = {
  morgan: as("prn_nf-morgan-lee"),
  amara: as("prn_nf-student-amara"),
  elena: as("prn_nf-student-elena"),
};

/** Well-known offerings. */
export const O = {
  bioFall: OfferingId.parse("off_nf-bio-fall-p2"),
};

/** A submission ID. */
export const sub = (id: string) => SubmissionId.parse(id);

/** A markdown document. */
export function doc(workspaceId: string, text: string, title: string): NewArtifact {
  return {
    workspaceId: workspaceId as NewArtifact["workspaceId"],
    type: "document",
    title,
    content: { kind: "text", mediaType: "text/markdown", text },
    aiAssistance: { level: "none" },
  };
}

/** New text revision content. */
export const text = (value: string) => ({ content: { kind: "text", mediaType: "text/markdown", text: value } as const, aiAssistance: { level: "none" } as const });

/** Expects a promise to reject with a SchoolOS error code and, optionally, a message fragment. */
export async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code, ...(message === undefined ? {} : { message: expect.stringMatching(message) }) });
}

const decoder = new TextDecoder();

/** Every entry of an archive, decoded as text, keyed by path. */
export async function entryTexts(bytes: Uint8Array<ArrayBuffer>): Promise<Map<string, string>> {
  return new Map((await readZip(bytes)).map((e) => [e.path, decoder.decode(e.bytes)]));
}

/**
 * Re-writes an archive after `edit` changes its entries. With `refreshManifest`, the manifest's
 * digests and sizes are recomputed afterwards, as a forger would, so only deeper checks can catch
 * the edit.
 */
export async function rewrite(
  bytes: Uint8Array<ArrayBuffer>,
  edit: (entries: ZipEntry[]) => void,
  options: { refreshManifest?: boolean } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const entries = await readZip(bytes);
  edit(entries);
  if (options.refreshManifest === true) {
    const manifestEntry = entries.find((e) => e.path === "manifest.json")!;
    const manifest = StudentArchiveManifest.parse(JSON.parse(decoder.decode(manifestEntry.bytes)));
    for (const item of manifest.items) {
      const entry = entries.find((e) => e.path === item.path);
      if (entry === undefined) continue;
      item.digest = await sha256Digest(entry.bytes);
      item.sizeBytes = entry.bytes.byteLength;
    }
    manifestEntry.bytes = canonicalJsonBytes(manifest);
  }
  return writeZip(entries);
}

/** Replaces the JSON in one entry. */
export function editJson(entries: ZipEntry[], path: string, change: (value: Record<string, unknown>) => void): void {
  const entry = entries.find((e) => e.path === path);
  if (entry === undefined) throw new Error(`no entry ${path}`);
  const value = JSON.parse(decoder.decode(entry.bytes)) as Record<string, unknown>;
  change(value);
  entry.bytes = canonicalJsonBytes(value);
}
