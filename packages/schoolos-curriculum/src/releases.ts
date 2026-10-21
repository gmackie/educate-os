import type { ContentStudioStorage, StudioRelease } from "@schoolos/content-studio";
import type { ResourceReleaseRef } from "./model.ts";

/**
 * Finds Content Studio releases. Only a release exists to be found: an item still in quarantine,
 * in review or rejected has none, so it can never be referenced by an activity.
 */
export interface ReleaseLookup {
  /** The release, or undefined if the resource has no release with that version. */
  getRelease(ref: ResourceReleaseRef): Promise<StudioRelease | undefined>;
}

/** A {@link ReleaseLookup} over the district's Content Studio storage. */
export function contentStudioReleases(storage: ContentStudioStorage): ReleaseLookup {
  return {
    async getRelease(ref) {
      return (await storage.listReleases(ref.resourceId)).find((release) => release.descriptor.release.version === ref.version);
    },
  };
}
