import {
  SchoolOsError,
  type Scope,
  type ActivityId,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type OfferingId,
} from "@schoolos/contracts";
import type { ActivityLink, PlatformRegistration } from "@schoolos/lti";
import type { RegistrationTargets } from "./stores.ts";

/** An activity scope: an activity installed in one offering. */
export type ActivityScope = Extract<Scope, { level: "activity" }>;

/** An installed activity, as LTI needs it: where it is, and what a platform should call it. */
export interface CatalogActivity {
  readonly scope: ActivityScope;
  readonly title: string;
}

/** Where LTI looks activities up. The curriculum service (C05) installs them. */
export interface ActivityCatalog {
  /** The activity `activityId`, or `undefined` if no such activity is installed. */
  find(activityId: ActivityId): Promise<CatalogActivity | undefined>;
}

/** What {@link directoryRegistrationTargets} checks against. */
export interface DirectoryRegistrationTargetsOptions {
  readonly districtId: DistrictId;
  /** The district directory, read on every check. */
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  readonly activities: ActivityCatalog;
}

/**
 * The {@link RegistrationTargets} for one district: a registration must belong to the district and
 * name an issuer the district trusts, each offering it maps must be in the directory, and each
 * activity it links must be installed in the offering the link names. Unknown targets are
 * `not-found`, so a registration can never point a course at an offering or activity that does not
 * exist, or at another district's.
 */
export function directoryRegistrationTargets(options: DirectoryRegistrationTargetsOptions): RegistrationTargets {
  const assertActivity = async (offeringId: OfferingId, activityId: ActivityId): Promise<void> => {
    const activity = await options.activities.find(activityId);
    if (activity === undefined || activity.scope.districtId !== options.districtId || activity.scope.offeringId !== offeringId) {
      throw new SchoolOsError("not-found", "No such activity in that offering.");
    }
  };
  return {
    async assertRegistration(registration: PlatformRegistration) {
      const directory = await options.directory();
      if (registration.districtId !== options.districtId || directory.district.id !== options.districtId) {
        throw new SchoolOsError("forbidden", "That registration belongs to another district.");
      }
      if (!directory.district.trustedIssuers.includes(registration.issuer)) {
        throw new SchoolOsError("conflict", "The district does not trust this platform's issuer yet; add it to the trusted issuers first.");
      }
      const offerings = new Set(directory.offerings.map((offering) => offering.id));
      if (registration.offerings.some((mapping) => !offerings.has(mapping.offeringId))) {
        throw new SchoolOsError("not-found", "No such offering.");
      }
      for (const link of registration.activityLinks) await assertActivity(link.offeringId, link.activityId);
    },
    async assertActivityLink(link: ActivityLink) {
      const directory = await options.directory();
      if (!directory.offerings.some((offering) => offering.id === link.offeringId)) throw new SchoolOsError("not-found", "No such offering.");
      await assertActivity(link.offeringId, link.activityId);
    },
  };
}
