import { CapabilityId, InstanceId, type DistrictDirectorySnapshot } from "@schoolos/contracts";
import {
  CommercialAccountId,
  DistrictAgent,
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

/** A registry with in-memory storage, plus the storage so tests can inspect what was kept. */
export function makeRegistry(clock: ReturnType<typeof manualClock>) {
  const storage = new InMemoryInstanceRegistryStorage();
  return { storage, registry: new InstanceRegistry({ storage, now: clock.now }) };
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
      commercialAccountId: CommercialAccountId.parse(`acct_${snapshot.district.id.slice("dst_".length)}`),
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
