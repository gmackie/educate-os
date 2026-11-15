// The `family-adult` relationship (ADR-0016): the policy engine's only way to reach a family's
// records. It reads stored membership on every decision, so an adult removed from a family, or a
// deleted family, loses access at once.
import { FamilyId, LearnerId, type PrincipalId, type ResourceRef } from "@educateos/contracts";
import type { HomeLearningStore } from "./storage.ts";

/** One relationship fact, in the shape the policy package's `RelationshipSource` returns. */
export interface FamilyAdultFact {
  relationship: "family-adult";
  /** The family that establishes it, recorded as the decision's grant. */
  grantId: string;
}

/**
 * A relationship source: `family-adult` when `subject` is an adult of the family a `family`
 * resource names, or of the family whose child a `home-practice` resource names, at that family's
 * district scope. Nothing for any other kind or scope, or for a resource with no ID.
 */
export function familyAdults(store: HomeLearningStore) {
  return {
    async relationships(subject: PrincipalId, resource: ResourceRef): Promise<readonly FamilyAdultFact[]> {
      if (resource.id === undefined || resource.scope.level !== "district") return [];
      let familyId: FamilyId | undefined;
      if (resource.kind === "family") {
        familyId = FamilyId.safeParse(resource.id).data;
      } else if (resource.kind === "home-practice") {
        const learnerId = LearnerId.safeParse(resource.id).data;
        familyId = learnerId === undefined ? undefined : await store.familyOfLearner(learnerId);
      }
      if (familyId === undefined) return [];
      const family = await store.loadFamily(familyId);
      if (family === undefined || family.districtId !== resource.scope.districtId) return [];
      return family.adults.some((a) => a.principalId === subject) ? [{ relationship: "family-adult", grantId: family.id }] : [];
    },
  };
}
