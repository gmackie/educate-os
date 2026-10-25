import { Scope } from "@educateos/contracts";
import type { CurriculumStorage } from "@educateos/curriculum";
import type { ActivityCatalog } from "./targets.ts";

/**
 * An {@link ActivityCatalog} over the curriculum service's storage: an installation's scope, and
 * the title of the definition version it pinned.
 */
export function curriculumActivityCatalog(storage: CurriculumStorage): ActivityCatalog {
  return {
    async find(activityId) {
      const installation = await storage.getInstallation(activityId);
      if (installation === undefined) return undefined;
      const definition = (await storage.listVersions(installation.definitionId))[installation.definitionVersion - 1];
      const scope = Scope.safeParse(installation.scope);
      if (definition === undefined || !scope.success || scope.data.level !== "activity") return undefined;
      return { scope: scope.data, title: definition.content.title };
    },
  };
}
