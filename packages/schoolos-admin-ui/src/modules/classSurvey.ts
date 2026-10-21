// The classes an administrator can roll modules out to, with how many people each reaches.
//
// The district API has no route that lists classes to an administrator yet, but its dry-run plans
// report every class a change would reach, with its student and staff counts. Two dry runs reach
// every active class: one exposing every module to all active classes (the classes not yet using
// SchoolOS), and one turning every module off (the classes using it now). Plans change nothing, so
// this is safe to run at any time; a class-listing route would replace it.
import type { DistrictApiClient } from "@schoolos/api-client";
import type { OfferingId, SchoolId } from "@schoolos/contracts";
import { documentFromDesired, type DesiredStateView } from "../configDocument.ts";

/** A class an administrator can turn modules on for. */
export interface ClassSummary {
  /** The class. */
  offeringId: OfferingId;
  /** Its school. */
  schoolId: SchoolId;
  /** Students actively enrolled. */
  students: number;
  /** Teachers and co-teachers actively enrolled. */
  staff: number;
  /** Whether modules are visible to it now. */
  visibleNow: boolean;
}

function everyModule(desired: DesiredStateView, state: "enabled" | "disabled"): DesiredStateView["modules"] {
  return Object.fromEntries(Object.entries(desired.modules).map(([id, module]) => [id, { ...module, state }]));
}

/** Every active class, and every class modules are visible to now, sorted by class. */
export async function surveyClasses(client: DistrictApiClient, desired: DesiredStateView): Promise<ClassSummary[]> {
  const [everywhere, nowhere] = await Promise.all([
    client.call("admin.planConfig", {
      body: { document: documentFromDesired({ ...desired, modules: everyModule(desired, "enabled"), rollout: { ...desired.rollout, target: "all-active-offerings", offerings: [] } }) },
    }),
    client.call("admin.planConfig", { body: { document: documentFromDesired({ ...desired, modules: everyModule(desired, "disabled") }) } }),
  ]);
  const classes = new Map<OfferingId, ClassSummary>();
  for (const [plan, visibleNow] of [[everywhere, false], [nowhere, true]] as const) {
    if (!plan.ok) continue;
    for (const impact of plan.plan.offerings) {
      const reached = visibleNow ? impact.packsWithdrawn.length > 0 : impact.packsExposed.length > 0;
      if (!reached) continue;
      const known = classes.get(impact.offeringId);
      classes.set(impact.offeringId, {
        offeringId: impact.offeringId,
        schoolId: impact.schoolId,
        students: impact.students,
        staff: impact.staff,
        visibleNow: visibleNow || (known?.visibleNow ?? false),
      });
    }
  }
  return [...classes.values()].toSorted((a, b) => a.offeringId.localeCompare(b.offeringId));
}
