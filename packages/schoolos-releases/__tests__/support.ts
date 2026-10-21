import { CapabilityId, CommercialAccountId, InstanceId, type DistrictDirectorySnapshot, SchoolOsError } from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import {
  DistrictAgent,
  type EntitlementEvaluation,
  type EntitlementState,
  FakeCommercialAccountVerifier,
  type HealthProbe,
  InMemoryInstanceRegistryStorage,
  InMemorySequenceCounter,
  InstanceRegistry,
  type ReleaseChannel,
  type ReleaseOffer,
  type SignedEnvelope,
  SigningIdentity,
} from "@schoolos/fleet";
import {
  type DistrictReleasePolicy,
  DistrictReleaseManager,
  type DriftReport,
  InMemoryDistrictReleaseStore,
  type InstalledRelease,
  pinReleaseKeys,
  type ReleaseManifestStatement,
  type ReleaseTrust,
  RootReleaseSigner,
} from "../src/index.ts";

/** A clock the test moves by hand. */
export function manualClock(start = "2026-10-20T12:00:00.000Z") {
  let time = Date.parse(start);
  return {
    now: () => new Date(time),
    advance(ms: number) {
      time += ms;
    },
  };
}
/** A manual clock. */
export type Clock = ReturnType<typeof manualClock>;

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

/** A fake manifest digest, distinct per release. */
export function digestOf(releaseId: string): string {
  return [...releaseId].map((c) => c.charCodeAt(0).toString(16)).join("").padEnd(64, "0").slice(0, 64);
}

/** A release statement, valid for 30 days from the clock's now. */
export function statementFor(
  clock: Clock,
  releaseId: string,
  version: string,
  overrides: Partial<ReleaseManifestStatement> = {},
): ReleaseManifestStatement {
  return {
    releaseId,
    channel: "stable",
    version,
    minimumCompatibleVersion: "0.1.0",
    manifestSha256: digestOf(releaseId),
    migrations: [],
    issuedAt: clock.now().toISOString(),
    expiresAt: new Date(clock.now().getTime() + 30 * DAY).toISOString(),
    ...overrides,
  };
}

/** The release every district starts on. */
export function baseline(clock: Clock, overrides: Partial<InstalledRelease> = {}): InstalledRelease {
  return {
    releaseId: "r1-baseline",
    version: "0.1.0",
    minimumCompatibleVersion: "0.1.0",
    manifestSha256: digestOf("r1-baseline"),
    installedAt: clock.now().toISOString(),
    ...overrides,
  };
}

/**
 * The root's online release signer, its three offline root keys (any two of which sign a release
 * key set), and the trust a district pins for them.
 */
export async function makeSigner(): Promise<{ signer: RootReleaseSigner; rootKeys: SigningIdentity[]; trust: ReleaseTrust }> {
  const identity = await SigningIdentity.generate();
  const rootKeys = await Promise.all([1, 2, 3].map(() => SigningIdentity.generate()));
  const trust = await pinReleaseKeys({
    releaseKeys: [identity.publicKey],
    root: { threshold: 2, publicKeys: rootKeys.map((key) => key.publicKey) },
  });
  return { signer: new RootReleaseSigner(identity), rootKeys, trust };
}

/** An entitlement cache stand-in whose state the test sets. */
export function entitlementIn(initial: EntitlementState = "valid") {
  let state = initial;
  return {
    set(next: EntitlementState) {
      state = next;
    },
    async evaluate(): Promise<EntitlementEvaluation> {
      const blocked = state === "lapsed" || state === "absent";
      return { state, rootManagedChanges: blocked ? "blocked" : "allowed", classroom: "unaffected", capabilityIds: [] };
    },
  };
}

/** The instance ID of a synthetic district. */
export function instanceIdFor(snapshot: DistrictDirectorySnapshot): InstanceId {
  return InstanceId.parse(`ins_${snapshot.district.id.slice("dst_".length)}`);
}

/** A district's release manager on an in-memory store. */
export function makeManager(
  clock: Clock,
  trust: ReleaseTrust,
  options: { policy?: DistrictReleasePolicy; installed?: InstalledRelease; instanceId?: InstanceId } = {},
) {
  const store = new InMemoryDistrictReleaseStore();
  const entitlement = entitlementIn();
  const manager = new DistrictReleaseManager({
    instanceId: options.instanceId ?? instanceIdFor(NORTHFIELD),
    policy: options.policy ?? { channel: "stable", autoApply: false },
    store,
    initial: { trust, installed: options.installed ?? baseline(clock) },
    entitlement,
    now: clock.now,
  });
  return { manager, store, entitlement };
}

/** An offer signed directly by a signer, bypassing the registry, as a compromised root could. */
export async function signedOffer(
  signer: RootReleaseSigner,
  clock: Clock,
  statement: ReleaseManifestStatement,
  overrides: Partial<ReleaseOffer> & { signedManifest?: SignedEnvelope } = {},
): Promise<SignedEnvelope> {
  return await signer.signOffer({
    instanceId: instanceIdFor(NORTHFIELD),
    releaseId: statement.releaseId,
    releaseVersion: statement.version,
    channel: statement.channel,
    purpose: "upgrade",
    offerSequence: 1,
    manifestSha256: statement.manifestSha256,
    signedManifest: overrides.signedManifest ?? (await signer.signManifest(statement)),
    offeredAt: clock.now().toISOString(),
    expiresAt: new Date(clock.now().getTime() + 7 * DAY).toISOString(),
    ...overrides,
  });
}

/** A ready dry-run drift report for a release, as the installer would produce it. */
export function driftFor(statement: ReleaseManifestStatement, pendingMigrations: string[] = []): DriftReport {
  return {
    releaseId: statement.releaseId,
    manifestSha256: statement.manifestSha256,
    ready: true,
    changes: [{ resource: "worker:router", kind: "worker_script", action: "update", reason: "release content or configuration changed" }],
    pendingMigrations,
  };
}

/** A registered district with a fleet agent, for rollout tests. */
export async function registeredDistrict(
  registry: InstanceRegistry,
  snapshot: DistrictDirectorySnapshot,
  clock: Clock,
  trust: ReleaseTrust,
  channel: ReleaseChannel,
) {
  const instanceId = instanceIdFor(snapshot);
  const agent = new DistrictAgent({
    identity: await SigningIdentity.generate(),
    instanceId,
    sequence: new InMemorySequenceCounter(),
    sharesAggregateSpend: false,
    now: clock.now,
  });
  const slug = snapshot.district.id.slice("dst_".length);
  const receipt = await registry.register(await agent.register({
    districtLabel: snapshot.district.name,
    releaseVersion: "0.1.0",
    capabilityIds: [CapabilityId.parse("core-learning")],
    contactRole: "district-technology-admin",
    commercialAccountId: CommercialAccountId.parse(`acct_${slug}`),
  }));
  const { manager, entitlement } = makeManager(clock, trust, { policy: { channel, autoApply: false }, instanceId });
  const heartbeat = (releaseVersion: string, probes: HealthProbe[]) => agent.heartbeat({ releaseVersion, probes });
  const revokeManagement = async () => registry.revoke(await agent.revokeManagement(receipt.ownershipToken));
  return { instanceId, agent, manager, entitlement, heartbeat, revokeManagement };
}

/** A root registry on in-memory storage, whose commercial system vouches for both synthetic districts. */
export function makeRegistry(clock: Clock): InstanceRegistry {
  const accountVerifier = new FakeCommercialAccountVerifier([NORTHFIELD, RIVERBEND].map((snapshot) => ({
    commercialAccountId: CommercialAccountId.parse(`acct_${snapshot.district.id.slice("dst_".length)}`),
    verifiedContactRoles: ["district-technology-admin"],
    confirmedInstanceIds: [instanceIdFor(snapshot)],
  })));
  return new InstanceRegistry({ storage: new InMemoryInstanceRegistryStorage(), accountVerifier, now: clock.now });
}

/** The SchoolOsError a promise rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<SchoolOsError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof SchoolOsError)) throw new Error(`expected a SchoolOsError, got ${String(error)}`);
  return error;
}

export const HEALTHY: HealthProbe[] = [{ probeId: "d1", status: "ok" }];
export const FAILING: HealthProbe[] = [{ probeId: "d1", status: "failing", code: "d1.unreachable" }];

export { NORTHFIELD, RIVERBEND };
