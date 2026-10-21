import {
  SchoolOsError,
  type ActivityId,
  type Authorizer,
  type DistrictId,
  type RequestChannel,
} from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";
import { createDirectoryPrincipalResolver } from "@schoolos/identity";
import type { Clock, DeepLinkSelection, LtiBrokerOptions, ResolvedLaunch } from "@schoolos/lti";
import type { ContextServicesStore } from "./stores.ts";
import type { ActivityCatalog } from "./targets.ts";

/**
 * The broker's `principalResolver` for a district Worker: launches for its own district resolve
 * against the directory as it is now (a fresh resolver per launch, so a roster change or an
 * approved identity link takes effect at once); any other district is not served here.
 */
export function districtPrincipalResolver(districtId: DistrictId, store: AcademicStore): LtiBrokerOptions["principalResolver"] {
  return async (requested) => (requested === districtId ? createDirectoryPrincipalResolver((await store.load()).snapshot) : undefined);
}

/**
 * Records the LTI Advantage services an accepted launch reported for its offering, if any. Call it
 * from `onResourceLinkLaunch` and `onDeepLinkingRequest`: they are what an administrator later
 * builds the offering's grade route from.
 */
export async function recordLaunchServices(store: ContextServicesStore, launch: ResolvedLaunch, now: Clock = Date.now): Promise<void> {
  if (launch.services === undefined) return;
  await store.record({ offeringId: launch.offeringId, services: launch.services, observedAt: new Date(now()).toISOString() });
}

/** What {@link policySelectActivities} is built from. */
export interface PolicySelectActivitiesOptions {
  /** The district's policy engine (A02). */
  readonly authorizer: Authorizer;
  readonly activities: ActivityCatalog;
  /** Defaults to `http`: a deep link choice is a person's own action in the content picker. */
  readonly channel?: RequestChannel;
}

/**
 * The handler's `selectActivities`, authorized by policy. Each chosen activity must be installed
 * in the launch's offering, and the launch's principal must be allowed to `assign` it there
 * (course staff, by the default rule table). The whole choice is refused if any one is not.
 */
export function policySelectActivities(
  options: PolicySelectActivitiesOptions,
): (launch: ResolvedLaunch, activityIds: readonly ActivityId[]) => Promise<readonly DeepLinkSelection[]> {
  return async (launch, activityIds) => {
    const selections: DeepLinkSelection[] = [];
    for (const activityId of new Set(activityIds)) {
      const activity = await options.activities.find(activityId);
      if (activity === undefined || activity.scope.offeringId !== launch.offeringId || activity.scope.districtId !== launch.principal.districtId) {
        throw new SchoolOsError("not-found", "No such activity in this course.");
      }
      const decision = await options.authorizer.authorize({
        subject: { principalId: launch.principal.principalId, districtId: launch.principal.districtId },
        action: "assign",
        resource: { kind: "activity", id: activityId, scope: activity.scope, classification: "course" },
        context: { channel: options.channel ?? "http" },
      });
      if (decision.effect !== "allow") throw new SchoolOsError("forbidden", "You cannot add activities to this course.");
      selections.push({ activityId, title: activity.title });
    }
    return selections;
  };
}
