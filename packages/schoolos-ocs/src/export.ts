import type { VerifiedPrincipal } from "@schoolos/contracts";
import type { ActivityInstallation, CurriculumService, InstallActivityInput, OfferingScope } from "@schoolos/curriculum";
import type { ComposedCourse } from "./composer.ts";

/** One activity installation a composed course asks for, and the course item it comes from. */
export interface PlannedInstallation {
  /** The course item, as {@link outlineKey} writes it. */
  itemKey: string;
  input: InstallActivityInput;
}

/**
 * Maps a composed course onto curriculum activity installations for one offering (C05), in course
 * order. Each item names a published definition version, and installing pins that version. An
 * activity two modules both include is installed once, at its first place in the course. Resources
 * and Codex notes are not installed on their own: an activity carries the releases it uses, and
 * the curriculum service checks them against the offering when it installs.
 */
export function planInstallations(course: ComposedCourse, offering: OfferingScope): PlannedInstallation[] {
  const planned: PlannedInstallation[] = [];
  const seen = new Set<string>();
  for (const unit of course.units) {
    for (const item of unit.items) {
      if (item.kind !== "activity") continue;
      const { definitionId, version } = item.activity.definition;
      const key = `${definitionId}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      planned.push({ itemKey: item.key, input: { definitionId, version, offering } });
    }
  }
  return planned;
}

/** One installation made for a course item. */
export interface CourseInstallation {
  itemKey: string;
  installation: ActivityInstallation;
}

/**
 * Installs a composed course's activities into an offering through the curriculum service, which
 * authorizes the teacher and validates each activity against the class. Installations are made in
 * course order, one at a time; if one fails, those before it stay installed (each is a complete,
 * valid installation) and the error is rethrown.
 *
 * @throws SchoolOsError whatever {@link CurriculumService.install} throws.
 */
export async function installCourse(
  service: Pick<CurriculumService, "install">,
  subject: VerifiedPrincipal,
  course: ComposedCourse,
  offering: OfferingScope,
): Promise<CourseInstallation[]> {
  const installed: CourseInstallation[] = [];
  for (const { itemKey, input } of planInstallations(course, offering)) {
    installed.push({ itemKey, installation: await service.install(subject, input) });
  }
  return installed;
}
