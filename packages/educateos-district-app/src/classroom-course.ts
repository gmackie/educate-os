// The Google Classroom course an offering was imported from (SCHO-428), by the same rule as the
// "From Google Classroom" panel: only when the head configuration revision's roster is Google
// Classroom, and only for an offering that roster imported, whose source-map `sourcedId` is then its
// Classroom course ID.
import { DesiredState } from "@educateos/config";
import type { OfferingId } from "@educateos/contracts";
import type { ConfigRevisionStore, RosterSourceStore } from "./stores.ts";

const CLASSROOM_COURSE_ID = /^\d{1,32}$/;

/** The offering's Classroom course ID, or `undefined` when its roster is not Classroom or did not import it. */
export async function classroomCourseOf(
  stores: { config: Pick<ConfigRevisionStore, "list">; rosterSources: Pick<RosterSourceStore, "load"> },
  offeringId: OfferingId,
): Promise<string | undefined> {
  const head = (await stores.config.list()).at(-1);
  const desired = head === undefined ? undefined : DesiredState.safeParse(head.desired);
  if (desired?.success !== true || desired.data.rostering.provider !== "google-classroom") return undefined;
  const sourcedId = (await stores.rosterSources.load()).offerings[offeringId];
  return sourcedId !== undefined && CLASSROOM_COURSE_ID.test(sourcedId) ? sourcedId : undefined;
}
