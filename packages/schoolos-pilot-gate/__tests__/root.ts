// The root side of an outage: a district's entitlement cache holding a valid entitlement from the
// root, and a root client that fails every call.
import { InstanceId } from "@schoolos/contracts";
import type { DistrictId } from "@schoolos/contracts";
import { EntitlementCache, InMemoryEntitlementStore, signEnvelope, SigningIdentity } from "@schoolos/fleet";

const DAY_MS = 86_400_000;

/** A district's entitlement cache on `now`'s clock, a valid entitlement in it, and a root client that always fails. */
export async function entitlementWithRootDown(districtId: DistrictId, now: () => Date = () => new Date()) {
  const root = await SigningIdentity.generate();
  const instanceId = InstanceId.parse(`ins_${districtId.slice("dst_".length)}`);
  const cache = new EntitlementCache({ instanceId, rootPublicKey: root.publicKey, store: new InMemoryEntitlementStore(), now });
  const issuedAt = now().getTime();
  await cache.accept(await signEnvelope(root, "entitlement", {
    instanceId,
    revision: 1,
    capabilityIds: ["core-learning", "content-studio", "assessment-ci"],
    issuedAt: new Date(issuedAt).toISOString(),
    validUntil: new Date(issuedAt + 30 * DAY_MS).toISOString(),
    graceUntil: new Date(issuedAt + 44 * DAY_MS).toISOString(),
  }));
  let calls = 0;
  const rootDown = async (): Promise<unknown> => {
    calls += 1;
    throw new TypeError("fetch failed: connect ECONNREFUSED");
  };
  return { cache, rootDown, rootCalls: () => calls };
}
