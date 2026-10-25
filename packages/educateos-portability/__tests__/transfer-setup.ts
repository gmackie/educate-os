import { DistrictDirectorySnapshot, DistrictId, PrincipalId, type Caller, type PolicySettings } from "@educateos/contracts";
import { InMemoryAcademicStore } from "@educateos/academics";
import { RIVERBEND } from "@educateos/fixtures";
import {
  BackendArtifactStore,
  InMemoryArtifactRecordStore,
  InMemoryInlineTextTable,
  InMemoryR2Bucket,
  LearningArtifacts,
  type ArtifactStore,
} from "@educateos/learning-artifacts";
import { directoryPolicyInformation, PolicyEngine } from "@educateos/policy";
import { InMemoryWorkspaceStore, WorkspaceDirectory } from "@educateos/workspaces";
import {
  ConsentRevocationEndpoint,
  confirmIdentityLink,
  DirectTransferEndpoint,
  InMemoryConsentRevocationList,
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
export const ROOT_HOST = "root.educateos.example";

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
    status: "active",
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

/** The host of Riverbend's revocation endpoint. */
export const RIVERBEND_REVOCATION_HOST = "revocations.riverbend.example";

/**
 * Content storage that fails every write after the first `writesBeforeFailure`, as an R2 outage
 * part-way through an import would.
 */
export class FailingContentStore implements ArtifactStore {
  readonly #inner: ArtifactStore;
  writesBeforeFailure: number;

  constructor(inner: ArtifactStore, writesBeforeFailure: number) {
    this.#inner = inner;
    this.writesBeforeFailure = writesBeforeFailure;
  }

  async write(...args: Parameters<ArtifactStore["write"]>) {
    if (this.writesBeforeFailure <= 0) throw new Error("content storage is unavailable");
    this.writesBeforeFailure--;
    return this.#inner.write(...args);
  }

  async read(...args: Parameters<ArtifactStore["read"]>) {
    return this.#inner.read(...args);
  }

  hasProvider(...args: Parameters<ArtifactStore["hasProvider"]>) {
    return this.#inner.hasProvider(...args);
  }
}

/** Riverbend: the destination district's services, with the import policy its admin set. */
export function riverbend(options: {
  pinned?: DestinationImportPolicy["pinnedSources"];
  acceptedItemClasses?: TransferItemClass[];
  acceptUnverifiedSources?: boolean;
  /** Fail content writes after this many, until the test raises it. */
  contentWritesBeforeFailure?: number;
} = {}) {
  const academics = InMemoryAcademicStore.seeded(riverbendWithAmara());
  const workspaceStore = new InMemoryWorkspaceStore();
  const clock = { now: new Date("2026-10-21T09:00:00Z") };
  const policy = new PolicyEngine({
    information: directoryPolicyInformation(academics, { effectivePolicy: async () => FLOOR }),
    audit: { record: async () => {} },
  });
  const workspaces = new WorkspaceDirectory({ workspaces: workspaceStore, directory: academics, policy, retention: { courseWorkspaceRetentionDays: 30 }, now: () => clock.now });
  const records = new InMemoryArtifactRecordStore();
  const content = new FailingContentStore(new BackendArtifactStore({ text: new InMemoryInlineTextTable(), r2: new InMemoryR2Bucket() }), options.contentWritesBeforeFailure ?? Infinity);
  const artifacts = new LearningArtifacts({
    records,
    content,
    workspaces: workspaceStore,
    directory: academics,
    policy,
    // Riverbend approves its own document host, not Northfield's.
    approvedExternalHosts: ["docs.riverbend.example"],
    now: () => clock.now,
  });
  const links = new InMemoryPortableIdentityLinkStore();
  const ledger = new InMemoryImportLedger();
  const revocations = new InMemoryConsentRevocationList();
  const importPolicy: DestinationImportPolicy = {
    self: RIVERBEND_PARTY,
    acceptedItemClasses: options.acceptedItemClasses ?? ["artifacts", "submissions", "feedback", "resources"],
    pinnedSources: options.pinned ?? [],
    acceptUnverifiedSources: options.acceptUnverifiedSources ?? false,
  };
  const importer = new StudentArchiveImporter({ artifacts, workspaces, links, ledger, revocations, now: () => clock.now, policy: importPolicy });
  const endpoint = new DirectTransferEndpoint({ importer, links, districtId: RB });
  const revocationEndpoint = new ConsentRevocationEndpoint({ self: importPolicy.self, pinnedSources: importPolicy.pinnedSources, revocations });
  const root = new FailingRoot();

  /** Riverbend's admin confirms that an archive's learner is `principal`. */
  const linkLearner = (sourcePseudonym: string, principal: Caller, admin: Caller = R.admin) =>
    confirmIdentityLink({ policy, links, directory: academics }, admin, {
      sourceInstanceLabel: NORTHFIELD_PARTY.label,
      sourcePseudonym: SubjectRef.parse(sourcePseudonym),
      destinationPrincipalId: principal.principal.principalId,
    });

  return { academics, workspaces, artifacts, records, content, links, ledger, revocations, importer, endpoint, revocationEndpoint, root, clock, linkLearner };
}
