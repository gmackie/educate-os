import type { CatalogMirror } from "@educateos/catalog";
import { type CompetencyRef, RegistryUri, ResourceAlignment } from "@educateos/registry";
import { z } from "zod";

/** Resolves a competency a reviewer names to the framework revision the district approved. */
export interface AlignmentSource {
  /** The competency at the district's approved revision, or undefined if it has none with that URI. */
  resolve(frameworkKey: string, competencyUri: string): Promise<CompetencyRef | undefined>;
}

/**
 * An {@link AlignmentSource} over the district's catalog mirror: a competency resolves only if it
 * is an item of the framework release the district approved, so a release can never be aligned
 * to a proposed, retired or unselected framework.
 */
export function catalogAlignmentSource(mirror: CatalogMirror): AlignmentSource {
  return {
    async resolve(frameworkKey, competencyUri) {
      let release;
      try {
        release = await mirror.approvedRelease(frameworkKey);
      } catch {
        return undefined;
      }
      if (release === undefined || !release.content.nodes?.some((node) => node.uri === competencyUri)) return undefined;
      const { framework } = release.content;
      return { competencyUri, frameworkUri: framework.uri, frameworkRevision: framework.provenance.sourceRevision };
    },
  };
}

/** An alignment a reviewer asserts when approving: a catalog item, its purpose, and why. */
export const AlignmentInput = z.strictObject({
  frameworkKey: z.string().min(1).max(100),
  competencyUri: RegistryUri,
  purpose: ResourceAlignment.shape.purpose,
  /** The reviewer's evidence for the alignment, such as the section of the resource that teaches it. */
  evidence: z.string().trim().min(1).max(2000),
});
/** An alignment input. */
export type AlignmentInput = z.infer<typeof AlignmentInput>;
