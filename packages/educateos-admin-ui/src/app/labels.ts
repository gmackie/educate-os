// How the console names things the district API identifies by code. Capability packs have no
// display names yet, so they are named from their kebab-case IDs. Schools, terms and classes are
// named by `admin.directoryNames` (`directoryNames`), which names no person, falling back to their
// code only for a record it does not list.
import type { RouteResponse } from "@educateos/api-client";

/** A capability pack's name, from its ID: `assessment-ci` reads "Assessment ci". */
export function packName(capabilityId: string): string {
  const spaced = capabilityId.replaceAll("-", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The names of the district's schools, terms and classes, by ID. */
export interface DirectoryNames {
  /** A school's name. */
  school: (schoolId: string) => string;
  /** A term's name. */
  term: (termId: string) => string;
  /** A class's name: its course and section, such as "Biology · Period 2". */
  offering: (offeringId: string) => string;
  /** `text` with every class ID in it replaced by the class's name. */
  withClassNames: (text: string) => string;
}

const code = (id: string) => id.replace(/^[a-z]+_/, "");

/**
 * Names from the district's directory names. Without them, or for a record they do not list, each
 * record is named by its code, so a screen still renders while they load or if they cannot be read.
 */
export function directoryNames(names?: RouteResponse<"admin.directoryNames">): DirectoryNames {
  const schools = new Map(names?.schools.map((s) => [s.id as string, s.name]));
  const terms = new Map(names?.terms.map((t) => [t.id as string, t.name]));
  const offerings = new Map(names?.offerings.map((o) => [o.id as string, o.name]));
  return {
    school: (schoolId) => schools.get(schoolId) ?? code(schoolId),
    term: (termId) => terms.get(termId) ?? code(termId),
    offering: (offeringId) => offerings.get(offeringId) ?? code(offeringId),
    withClassNames: (text) => text.replaceAll(/\boff_[A-Za-z0-9_-]+/g, (id) => offerings.get(id) ?? id),
  };
}

/** A count with its noun, singular or plural. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}

/**
 * A calendar date such as a term's start, `YYYY-MM-DD`, in the reader's locale. It is a date, not
 * a moment, so it is formatted in UTC, where it was parsed, and never shifts a day.
 */
export function formatDate(isoDate: string): string {
  const parsed = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? isoDate : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(parsed);
}

/** A moment, such as when a link was redeemed, in the reader's locale and time zone. */
export function formatMoment(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  return Number.isNaN(parsed.getTime()) ? isoTimestamp : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

/** A billing month, `YYYY-MM`, in the reader's locale, such as "October 2026". */
export function formatMonth(period: string): string {
  const parsed = new Date(`${period.slice(0, 7)}-01T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? period : new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(parsed);
}
