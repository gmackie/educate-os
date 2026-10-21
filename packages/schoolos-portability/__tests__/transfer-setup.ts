import { DistrictDirectorySnapshot, DistrictId, PrincipalId, type PolicySettings } from "@schoolos/contracts";
import { InMemoryAcademicStore, type Caller } from "@schoolos/academics";
import { RIVERBEND } from "@schoolos/fixtures";
import {
  BackendArtifactStore,
  InMemoryArtifactRecordStore,
  InMemoryInlineTextTable,
  InMemoryR2Bucket,
  LearningArtifacts,
} from "@schoolos/learning-artifacts";
import { directoryPolicyInformation, PolicyEngine } from "@schoolos/policy";
import { InMemoryWorkspaceStore, WorkspaceDirectory } from "@schoolos/workspaces";
import {
  confirmIdentityLink,
  DirectTransferEndpoint,
  InMemoryImportLedger,
  InMemoryPortableIdentityLinkStore,
  StudentArchiveImporter,
  SubjectRef,
  TransferParty,
  type DestinationImportPolicy,
  type TransferItemClass,
} from "../src/index.ts";

const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "shared-by-student",
  teacherObservation: "assigned-work-and-shared-conversations",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

const RB = DistrictId.parse("dst_riverbend");

/** The source district, by label and fleet instance ID. */
export const NORTHFIELD_PARTY = TransferParty.parse({ label: "Northfield Public Schools (synthetic)", instanceId: "ins_northfield" });
/** The destination district, by label and fleet instance ID. */
export const RIVERBEND_PARTY = TransferParty.parse({ label: "Riverbend Unified (synthetic)", instanceId: "ins_riverbend" });

/** The host of Riverbend's transfer endpoint. */
export const RIVERBEND_TRANSFER_HOST = "transfer.riverbend.example";
/** The fleet root's host. Nothing in a transfer may contact it. */
export const ROOT_HOST = "root.schoolos.example";

/** An HTTP caller in Riverbend. */
export function rb(principalId: string): Caller {
  return { principal: { principalId: PrincipalId.parse(principalId), districtId: RB }, channel: "http" };
}

/** Riverbend callers. Amara is Northfield's Amara, newly enrolled here under a Riverbend account. */
export const R = {
  amara: rb("prn_rb-student-amara"),
  ines: rb("prn_rb-student-ines"),
  admin: rb("prn_rb-district-admin"),
  morgan: rb("prn_rb-morgan-lee"),
};

/** Riverbend, with Amara's new account. */
function riverbendWithAmara(): DistrictDirectorySnapshot {
  const snapshot = structuredClone(RIVERBEND) as DistrictDirectorySnapshot;
  snapshot.principals.push({
    id: PrincipalId.parse("prn_rb-student-amara"),
    districtId: RB,
    kind: "student",
    displayName: "Amara Okafor",
    externalIdentities: [{ districtId: RB, issuer: "https://login.riverbend.example", subject: "rb-s-777" }],
  } as DistrictDirectorySnapshot["principals"][number]);
  return DistrictDirectorySnapshot.parse(snapshot);
}

/**
 * A fleet root client, as a provisioned district agent would hold one. Every call fails the test
 * and is recorded, so a test can also assert afterwards that it was never reached.
 */
export class FailingRoot {
  readonly calls: string[] = [];

  /** Any request to the root. */
  async fetch(request: Request): Promise<Response> {
    this.calls.push(request.url);
    throw new Error(`the root was called: ${request.method} ${request.url}`);
  }
}

/**
 * The network both districts share in a test. It reaches Riverbend's transfer endpoint and the
 * root, records every request, and refuses every other host.
 */
export class TestNetwork {
  readonly requests: string[] = [];
  readonly #routes = new Map<string, (request: Request) => Promise<Response>>();

  /** Routes requests for `host` to `handler`. */
  route(host: string, handler: (request: Request) => Promise<Response>): void {
    this.#routes.set(host, handler);
  }

  /** The `fetch` given to a district's services. */
  readonly fetch = async (request: Request): Promise<Response> => {
    this.requests.push(request.url);
    const handler = this.#routes.get(new URL(request.url).host);
    if (handler === undefined) throw new Error(`no route to ${request.url}`);
    return handler(request);
  };
}

/** Riverbend: the destination district's services, with the import policy its admin set. */
export function riverbend(options: {
  pinned?: DestinationImportPolicy["pinnedSources"];
  acceptedItemClasses?: TransferItemClass[];
  acceptUnverifiedSources?: boolean;
} = {}) {
  const academics = InMemoryAcademicStore.seeded(riverbendWithAmara());
  const workspaceStore = new InMemoryWorkspaceStore();
  const clock = { now: new Date("2026-10-21T09:00:00Z") };
  const policy = new PolicyEngine({
    information: directoryPolicyInformation(academics, { effectivePolicy: async () => FLOOR }),
    audit: { record: async () => {} },
  });
  const workspaces = new WorkspaceDirectory({ workspaces: workspaceStore, directory: academics, policy, retention: { courseWorkspaceRetentionDays: 30 }, now: () => clock.now });
  const artifacts = new LearningArtifacts({
    records: new InMemoryArtifactRecordStore(),
    content: new BackendArtifactStore({ text: new InMemoryInlineTextTable(), r2: new InMemoryR2Bucket() }),
    workspaces: workspaceStore,
    directory: academics,
    policy,
    // Riverbend approves its own document host, not Northfield's.
    approvedExternalHosts: ["docs.riverbend.example"],
    now: () => clock.now,
  });
  const links = new InMemoryPortableIdentityLinkStore();
  const ledger = new InMemoryImportLedger();
  const importer = new StudentArchiveImporter({
    artifacts,
    workspaces,
    links,
    ledger,
    now: () => clock.now,
    policy: {
      self: RIVERBEND_PARTY,
      acceptedItemClasses: options.acceptedItemClasses ?? ["artifacts", "submissions", "feedback", "resources"],
      pinnedSources: options.pinned ?? [],
      acceptUnverifiedSources: options.acceptUnverifiedSources ?? false,
    },
  });
  const endpoint = new DirectTransferEndpoint({ importer, links, districtId: RB });
  const root = new FailingRoot();

  /** Riverbend's admin confirms that an archive's learner is `principal`. */
  const linkLearner = (sourcePseudonym: string, principal: Caller, admin: Caller = R.admin) =>
    confirmIdentityLink({ policy, links, directory: academics }, admin, {
      sourceInstanceLabel: NORTHFIELD_PARTY.label,
      sourcePseudonym: SubjectRef.parse(sourcePseudonym),
      destinationPrincipalId: principal.principal.principalId,
    });

  return { academics, workspaces, artifacts, links, ledger, importer, endpoint, root, clock, linkLearner };
}
