import {
  OfferingId,
  EducateOsError,
  type Action,
  type Authorizer,
  type Caller,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type ResourceRef,
} from "@educateos/contracts";

/** The district itself, as the resource district configuration is decided on. */
export function districtResource(districtId: DistrictId): ResourceRef {
  return { kind: "district", id: districtId, scope: { level: "district", districtId }, classification: "district-internal" };
}

/** Asks the policy engine whether `caller` may `action` on `resource`, throwing `refusal()` if not. */
export async function authorizeLti(
  authorizer: Authorizer,
  caller: Caller,
  action: Action,
  resource: ResourceRef,
  refusal: () => EducateOsError,
): Promise<void> {
  const decision = await authorizer.authorize({ subject: caller.principal, action, resource, context: { channel: caller.channel } });
  if (decision.effect !== "allow") throw refusal();
}

/**
 * Authorizes `action` on the offering `rawOfferingId` names, and returns its ID. An unknown offering,
 * or one of another district, is refused exactly as a forbidden one is, so the answer reveals nothing.
 */
export async function authorizeLtiOffering(
  options: { authorizer: Authorizer; districtId: DistrictId; directory: DistrictDirectorySnapshot },
  caller: Caller,
  action: Action,
  rawOfferingId: unknown,
  refusal: () => EducateOsError,
): Promise<OfferingId> {
  const id = OfferingId.safeParse(rawOfferingId);
  const offering = id.success ? options.directory.offerings.find((o) => o.id === id.data) : undefined;
  if (offering === undefined || offering.districtId !== options.districtId) throw refusal();
  await authorizeLti(options.authorizer, caller, action, {
    kind: "offering",
    id: offering.id,
    scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
    classification: "district-internal",
  }, refusal);
  return offering.id;
}
