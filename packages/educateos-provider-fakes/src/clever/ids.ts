// Clever's identifiers for seed records, shared by the Clever Data API fake and the Clever preset
// of the OIDC fake so that the person who signs in is the user the roster lists. Clever IDs are
// 24-hex-digit ObjectIds (https://dev.clever.com/docs/users: "id … globally unique"); in API v3.x
// a user has one `id` and a `legacy_id` per role, and only a student's `legacy_id` equals its `id`
// (https://dev.clever.com/docs/multi-role-users-in-clever).
import { hexId } from "../ids.ts";
import type { DistrictSeed } from "../types.ts";

/** The Clever collections a seed projects into, as the v3.1 paths name them. */
export type CleverCollection = "districts" | "schools" | "terms" | "courses" | "sections" | "users";

/** The roles of a v3.x Clever user, as the keys of its `roles` object. */
export type CleverRole = "student" | "teacher" | "staff" | "district_admin" | "contact";

/** The Clever ID of the seed's district. */
export function cleverDistrictId(seed: Pick<DistrictSeed, "id">): string {
  return hexId("clever:district", seed.id);
}

/** The Clever ID of a seed record in `collection`, scoped to the seed's district. */
export function cleverId(seed: Pick<DistrictSeed, "id">, collection: Exclude<CleverCollection, "districts">, recordId: string): string {
  return hexId(`clever:${collection}`, `${seed.id}\u0000${recordId}`);
}

/** A seed person's v3.x (multi-role) Clever user ID: the OIDC `sub` and `multi_role_user_id`. */
export function cleverUserId(seed: Pick<DistrictSeed, "id"> & Partial<Pick<DistrictSeed, "people">>, personId: string): string {
  return seed.people?.find((p) => p.id === personId)?.vendorIds?.clever ?? cleverId(seed, "users", personId);
}

/**
 * The `legacy_id` of one of a person's roles: the pre-v3 ID, which the OIDC `user_id` claim
 * carries. A student's equals their user ID; every other role has its own.
 */
export function cleverLegacyId(seed: Pick<DistrictSeed, "id"> & Partial<Pick<DistrictSeed, "people">>, personId: string, role: CleverRole): string {
  return role === "student" ? cleverUserId(seed, personId) : hexId(`clever:legacy:${role}`, `${seed.id}\u0000${personId}`);
}
