import { z } from "zod";
import {
  checkDirectoryIntegrity,
  DistrictId,
  PrincipalId,
  PrincipalKind,
  roleAssignmentInForce,
  EducateOsError,
  type DistrictDirectorySnapshot,
  type Principal,
} from "@educateos/contracts";

/**
 * The key the Workshop kernel names an authenticated user by (`AiChatAuthorInfo.id`): for an
 * Access user, the name its `UserDurableObject` is derived from. It is what the kernel tells
 * services like the AI call guard about who a call is for.
 *
 * Opaque here, and matched exactly. It is often an email address, but it is never compared with
 * `Principal.email` (ADR-0003): it reaches a principal only through a {@link WorkshopUserLink} an
 * administrator confirmed, so an address reassigned in the directory never moves it.
 */
export const WorkshopUserKey = z
  .string()
  .min(1)
  .max(320)
  .regex(/^[^\p{Cc}\s]+$/u, "expected a Workshop user key")
  .brand<"workshopUserKey">();
/** A Workshop user key. */
export type WorkshopUserKey = z.infer<typeof WorkshopUserKey>;

/**
 * A district administrator's confirmation that one Workshop user is one principal: the adoption a
 * migration plan proposes (`planEmailKeyedMigration`), or a link made for a new user. It is the only
 * way a Workshop user resolves to a principal.
 */
export const WorkshopUserLink = z.strictObject({
  districtId: DistrictId,
  workshopUser: WorkshopUserKey,
  principalId: PrincipalId,
  /** The district administrator who confirmed it. */
  confirmedBy: PrincipalId,
  confirmedAt: z.iso.datetime(),
});
/** A Workshop user link. */
export type WorkshopUserLink = z.infer<typeof WorkshopUserLink>;

/** The principal a Workshop user resolved to. */
export const WorkshopUserPrincipal = z.strictObject({
  districtId: DistrictId,
  principalId: PrincipalId,
  kind: PrincipalKind,
});
/** A resolved Workshop user. */
export type WorkshopUserPrincipal = z.infer<typeof WorkshopUserPrincipal>;

/** Resolves Workshop users of one district to its principals. */
export interface WorkshopUserResolver {
  /** The district this resolver resolves into. */
  readonly districtId: DistrictId;
  /**
   * The principal `workshopUser` is linked to. Throws `EducateOsError("unauthenticated")` when it is
   * linked to none in this district, or its link no longer names a person in the directory.
   */
  resolve(workshopUser: string): WorkshopUserPrincipal;
}

const UNLINKED = "This Workshop account is not linked to a principal in this district.";

function requireIntact(directory: DistrictDirectorySnapshot): void {
  if (checkDirectoryIntegrity(directory).length > 0) {
    throw new EducateOsError("unavailable", "The district directory failed its integrity checks.");
  }
}

/** The person `principalId` names in `directory`, if it names one. Services never act as Workshop users. */
function linkablePrincipal(directory: DistrictDirectorySnapshot, principalId: PrincipalId): Principal | undefined {
  const principal = directory.principals.find((p) => p.id === principalId);
  return principal === undefined || principal.kind === "service" ? undefined : principal;
}

/**
 * A {@link WorkshopUserResolver} over one directory snapshot and its confirmed links. Links of any
 * other district are ignored, and a Workshop user with more than one link resolves to no one, so a
 * mistaken second confirmation fails closed rather than picking either principal.
 *
 * Throws `EducateOsError("unavailable")` if the snapshot fails `checkDirectoryIntegrity`.
 */
export function createWorkshopUserResolver(directory: DistrictDirectorySnapshot, links: readonly WorkshopUserLink[]): WorkshopUserResolver {
  requireIntact(directory);
  const districtId = directory.district.id;
  const byUser = new Map<string, PrincipalId | null>();
  for (const link of links) {
    if (link.districtId !== districtId) continue;
    byUser.set(link.workshopUser, byUser.has(link.workshopUser) ? null : link.principalId);
  }
  return {
    districtId,
    resolve(workshopUser) {
      const principalId = byUser.get(workshopUser);
      const principal = principalId === undefined || principalId === null ? undefined : linkablePrincipal(directory, principalId);
      if (principal === undefined) throw new EducateOsError("unauthenticated", UNLINKED);
      return { districtId, principalId: principal.id, kind: principal.kind };
    },
  };
}

/** What an administrator confirms. */
export interface WorkshopUserLinkRequest {
  /** The Workshop user, as the kernel names it. */
  workshopUser: string;
  /** The principal it is. */
  principalId: PrincipalId;
  /** The confirming principal. It must hold `district-admin` at district scope. */
  confirmedBy: PrincipalId;
  /** When, as an ISO 8601 date-time. */
  confirmedAt: string;
}

/**
 * Confirms that a Workshop user is a principal, returning the link to store. Refuses (throws
 * `EducateOsError`) unless the confirmer is a district administrator, the principal is a person in
 * this district, and neither the Workshop user nor the principal is linked already: one Workshop
 * user is one principal, and a principal's Workshop data lives in one place.
 */
export function confirmWorkshopUserLink(
  directory: DistrictDirectorySnapshot,
  existing: readonly WorkshopUserLink[],
  request: WorkshopUserLinkRequest,
): WorkshopUserLink {
  requireIntact(directory);
  const districtId = directory.district.id;
  const parsed = WorkshopUserLink.safeParse({ districtId, ...request });
  if (!parsed.success) throw new EducateOsError("validation-failed", "The Workshop user link is malformed.");
  const link = parsed.data;
  const isAdmin = directory.roleAssignments.some((a) =>
    a.principalId === link.confirmedBy && a.role === "district-admin" && a.scope.level === "district" && a.scope.districtId === districtId
    && roleAssignmentInForce(a, new Date(link.confirmedAt)));
  if (!isAdmin) throw new EducateOsError("forbidden", "Only a district administrator can link Workshop accounts.");
  if (linkablePrincipal(directory, link.principalId) === undefined) throw new EducateOsError("not-found", "No such person in this district.");
  const local = existing.filter((other) => other.districtId === districtId);
  if (local.some((other) => other.workshopUser === link.workshopUser)) {
    throw new EducateOsError("conflict", "This Workshop account is already linked.");
  }
  if (local.some((other) => other.principalId === link.principalId)) {
    throw new EducateOsError("conflict", "This principal is already linked to a Workshop account.");
  }
  return link;
}
