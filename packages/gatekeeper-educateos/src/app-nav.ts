// The School app's sidebar entries (SCHO-218), from what the district says about the account's
// person. Display only: the Workshop links each entry to the app's own page, and the district still
// decides every request the page then makes. Imports nothing Workers-only, so it runs in Node; and
// not the district application's routes either, whose sources the Workers typings reject (ADR-0009),
// so the few responses read here are described with the contracts they are built from.
import type { CatalogCourse, CourseOffering, PrincipalKind, RoleAssignment, School } from "@educateos/contracts";
import type { GatekeeperAppNavEntry } from "@gadgets/workshop-shared/gatekeeper";

/** Reads one district API route as the person, rejecting on anything but success. */
export type DistrictGet = <T>(path: string) => Promise<T>;

type Me = { kind: PrincipalKind; roles: Pick<RoleAssignment, "role" | "scope">[]; enrollments: { role: string }[] };
type ClassView = { offering: CourseOffering; course: CatalogCourse };

/** What the entries are built from: the person's own view of their district. */
export interface SchoolNavFacts {
  kind: "staff" | "student" | "guardian";
  /** Whether they administer the whole district. */
  districtAdmin: boolean;
  /** The district's schools, for a district administrator. */
  schools: { id: string; name: string }[];
  /** The classes they teach. */
  teaching: { offeringId: string; label: string }[];
  /** The classes they are enrolled in, for a student. */
  learning: { offeringId: string; label: string }[];
  /** Their children, for a guardian. */
  children: { studentId: string; name: string }[];
}

const segment = encodeURIComponent;

/** A class's name as its people know it: the course, then the section. */
export const classLabel = (course: { title: string }, offering: { sectionName: string }): string => `${course.title} · ${offering.sectionName}`;

/**
 * The entries for `facts`: the person's own places first (Administration, Teacher Studio, their
 * Learning Home or family view), then each school, class and child under its heading.
 */
export function schoolNav(facts: SchoolNavFacts): GatekeeperAppNavEntry[] {
  const entries: GatekeeperAppNavEntry[] = [];
  if (facts.districtAdmin) entries.push({ label: "Administration", path: "/admin" });
  if (facts.teaching.length > 0) entries.push({ label: "Teacher Studio", path: "/teach" });
  if (facts.kind === "student") entries.push({ label: "Learning Home", path: "/learn" });
  if (facts.kind === "guardian") entries.push({ label: "Family", path: "/learn/family" });
  for (const school of facts.schools) entries.push({ label: school.name, path: `/schools/${segment(school.id)}`, group: "Schools" });
  for (const taught of facts.teaching) {
    entries.push({ label: taught.label, path: `/teach/classes/${segment(taught.offeringId)}/roster`, group: "Teaching" });
  }
  for (const enrolled of facts.learning) {
    entries.push({ label: enrolled.label, path: `/learn/courses/${segment(enrolled.offeringId)}`, group: "My classes" });
  }
  for (const child of facts.children) {
    entries.push({ label: child.name, path: `/learn/family/children/${segment(child.studentId)}`, group: "Family" });
  }
  return entries;
}

/**
 * Reads the facts from the district as the person. A list the person may not read (a staff member
 * who teaches nothing, say) counts as empty, so one refusal costs an entry rather than the section.
 */
export async function readSchoolNavFacts(get: DistrictGet): Promise<SchoolNavFacts> {
  const me = await get<Me>("/api/me");
  const kind = me.kind === "student" || me.kind === "guardian" ? me.kind : "staff";
  const districtAdmin = me.roles.some((role) => role.role === "district-admin" && role.scope.level === "district");
  const teaches = me.roles.some((role) => role.role === "teacher" || role.role === "co-teacher")
    || me.enrollments.some((enrollment) => enrollment.role === "teacher" || enrollment.role === "co-teacher");
  const orEmpty = <T>(read: Promise<T[]>): Promise<T[]> => read.catch(() => []);
  const [authoring, teaching, learning, children] = await Promise.all([
    districtAdmin ? orEmpty(get<{ schools: School[] }>("/api/admin/authoring").then((directory) => directory.schools)) : [],
    kind === "staff" && teaches ? orEmpty(get<ClassView[]>("/api/teacher/offerings")) : [],
    kind === "student" ? orEmpty(get<ClassView[]>("/api/student/offerings")) : [],
    kind === "guardian" ? orEmpty(get<{ studentPrincipalId: string; displayName: string }[]>("/api/guardian/children")) : [],
  ]);
  const current = <T extends { offering: { archivedAt?: unknown } }>(classes: T[]) => classes.filter(({ offering }) => offering.archivedAt === undefined);
  return {
    kind,
    districtAdmin,
    schools: authoring.map((school) => ({ id: school.id, name: school.name })),
    teaching: current(teaching).map(({ offering, course }) => ({ offeringId: offering.id, label: classLabel(course, offering) })),
    learning: current(learning).map(({ offering, course }) => ({ offeringId: offering.id, label: classLabel(course, offering) })),
    children: children.map((child) => ({ studentId: child.studentPrincipalId, name: child.displayName })),
  };
}
