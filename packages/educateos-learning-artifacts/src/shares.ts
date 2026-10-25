import type { PrincipalId, ResourceRef } from "@educateos/contracts";
import type { RelationshipFact, RelationshipSource } from "@educateos/policy";
import type { ArtifactRecordStore } from "./store.ts";

/**
 * The `share-grantee` relationships the district's share grants establish, for the policy
 * information point (SCHO-103). A grant counts only for its grantee and only for the artifact it
 * names, while that artifact exists, is not deleted, and is still owned by whoever made the grant:
 * only an owner shares. Whether the relationship lets the grantee read is the policy engine's
 * decision (`share.grantee.read`), which also requires the policy floor to allow sharing.
 */
export function artifactShareRelationships(records: ArtifactRecordStore): RelationshipSource {
  return {
    async relationships(subject: PrincipalId, resource: ResourceRef): Promise<RelationshipFact[]> {
      if (resource.kind !== "artifact" || resource.id === undefined) return [];
      const { state } = await records.load();
      const artifact = state.artifacts.find((a) => a.id === resource.id);
      if (
        artifact === undefined
        || artifact.deletedAt !== undefined
        || artifact.districtId !== resource.scope.districtId
        || artifact.ownerPrincipalId !== resource.ownerPrincipalId
      ) {
        return [];
      }
      return state.shares
        .filter((share) => share.artifactId === artifact.id && share.granteePrincipalId === subject && share.grantedBy === artifact.ownerPrincipalId)
        .map((share) => ({ relationship: "share-grantee", grantId: `share:${share.artifactId}:${share.granteePrincipalId}` }));
    },
  };
}
