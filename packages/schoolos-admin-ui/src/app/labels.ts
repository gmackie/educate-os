// How the console names things the district API identifies by code. The API has no display names
// for capability packs or classes yet, so packs are named from their kebab-case IDs and classes by
// their roster code.

/** A capability pack's name, from its ID: `assessment-ci` reads "Assessment ci". */
export function packName(capabilityId: string): string {
  const spaced = capabilityId.replaceAll("-", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A class's name: its roster code without the identifier prefix. */
export function className(offeringId: string): string {
  return offeringId.replace(/^off_/, "");
}

/** A school's name: its roster code without the identifier prefix. */
export function schoolName(schoolId: string): string {
  return schoolId.replace(/^sch_/, "");
}

/** A count with its noun, singular or plural. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}
