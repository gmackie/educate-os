import { CapabilityId, CommercialAccountId, InstanceId, type DistrictDirectorySnapshot } from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import {
  DistrictAgent,
  FakeCommercialAccountVerifier,
  InMemoryInstanceRegistryStorage,
  InMemorySequenceCounter,
  InstanceRegistry,
  SigningIdentity,
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

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

/** The instance a synthetic district registers. Derived from the district for readability only. */
export function instanceIdFor(snapshot: DistrictDirectorySnapshot): InstanceId {
  return InstanceId.parse(`ins_${snapshot.district.id.slice("dst_".length)}`);
}

/** The commercial account a synthetic district registers under. */
export function commercialAccountIdFor(snapshot: DistrictDirectorySnapshot): CommercialAccountId {
  return CommercialAccountId.parse(`acct_${snapshot.district.id.slice("dst_".length)}`);
}

/**
 * A commercial system that vouches for NORTHFIELD's and RIVERBEND's instances: each account has a
 * verified technology admin who confirmed the district's instance.
 */
export function verifierFor(snapshots: readonly DistrictDirectorySnapshot[] = [NORTHFIELD, RIVERBEND]) {
  return new FakeCommercialAccountVerifier(snapshots.map((snapshot) => ({
    commercialAccountId: commercialAccountIdFor(snapshot),
    verifiedContactRoles: ["district-technology-admin"],
    confirmedInstanceIds: [instanceIdFor(snapshot)],
  })));
}

/** A registry with in-memory storage, plus the storage and verifier so tests can inspect them. */
export function makeRegistry(clock: ReturnType<typeof manualClock>, accountVerifier = verifierFor()) {
  const storage = new InMemoryInstanceRegistryStorage();
  return { storage, accountVerifier, registry: new InstanceRegistry({ storage, accountVerifier, now: clock.now }) };
}

/** A district instance: its key pair and its agent. */
export async function makeDistrict(
  snapshot: DistrictDirectorySnapshot,
  clock: ReturnType<typeof manualClock>,
  options: { sharesAggregateSpend?: boolean; identity?: SigningIdentity; instanceId?: InstanceId } = {},
) {
  const identity = options.identity ?? (await SigningIdentity.generate());
  const instanceId = options.instanceId ?? instanceIdFor(snapshot);
  const agent = new DistrictAgent({
    identity,
    instanceId,
    sequence: new InMemorySequenceCounter(),
    sharesAggregateSpend: options.sharesAggregateSpend ?? false,
    now: clock.now,
  });
  const registration = () =>
    agent.register({
      districtLabel: snapshot.district.name,
      releaseVersion: "0.1.0",
      capabilityIds: [CapabilityId.parse("core-learning")],
      contactRole: "district-technology-admin",
      commercialAccountId: commercialAccountIdFor(snapshot),
    });
  return { identity, instanceId, agent, registration };
}

/** Every string in a district's directory that identifies or describes a person. */
export function personalStrings(snapshot: DistrictDirectorySnapshot): string[] {
  return snapshot.principals.flatMap((principal) => [
    principal.id,
    principal.displayName,
    ...(principal.email === undefined ? [] : [principal.email]),
    ...principal.externalIdentities.map((link) => link.subject),
  ]);
}
