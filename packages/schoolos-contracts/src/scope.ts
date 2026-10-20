import { z } from "zod";
import { ActivityId, DistrictId, OfferingId, SchoolId } from "./ids";

/**
 * The levels configuration and authorization attach to, from widest to narrowest. Policy resolves
 * in this order (see `policy-floor.ts`), so a narrower level can only tighten what a wider one
 * set.
 */
export const SCOPE_LEVELS = ["district", "school", "offering", "activity"] as const;

/** One of {@link SCOPE_LEVELS}. */
export const ScopeLevel = z.enum(SCOPE_LEVELS);
/** A scope level. */
export type ScopeLevel = z.infer<typeof ScopeLevel>;

/**
 * Where a resource, grant or configuration lives. Each level carries all of its ancestors, so a
 * scope is self-describing: checking that it falls inside a district never needs a lookup that
 * could be stale or missing.
 */
export const Scope = z.discriminatedUnion("level", [
  z.strictObject({ level: z.literal("district"), districtId: DistrictId }),
  z.strictObject({ level: z.literal("school"), districtId: DistrictId, schoolId: SchoolId }),
  z.strictObject({
    level: z.literal("offering"),
    districtId: DistrictId,
    schoolId: SchoolId,
    offeringId: OfferingId,
  }),
  z.strictObject({
    level: z.literal("activity"),
    districtId: DistrictId,
    schoolId: SchoolId,
    offeringId: OfferingId,
    activityId: ActivityId,
  }),
]);
/** A district, school, offering or activity scope. */
export type Scope = z.infer<typeof Scope>;

/**
 * Whether `inner` is `outer` or lies beneath it. Scopes in different districts never contain one
 * another, whatever their other fields say.
 */
export function scopeContains(outer: Scope, inner: Scope): boolean {
  if (outer.districtId !== inner.districtId) return false;
  if (SCOPE_LEVELS.indexOf(inner.level) < SCOPE_LEVELS.indexOf(outer.level)) return false;
  switch (outer.level) {
    case "district":
      return true;
    case "school":
      return "schoolId" in inner && inner.schoolId === outer.schoolId;
    case "offering":
      return "offeringId" in inner && inner.schoolId === outer.schoolId
        && inner.offeringId === outer.offeringId;
    case "activity":
      return inner.level === "activity" && inner.schoolId === outer.schoolId
        && inner.offeringId === outer.offeringId && inner.activityId === outer.activityId;
  }
}
