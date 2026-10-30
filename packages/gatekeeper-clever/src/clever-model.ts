// Projections from Clever records to the agent-facing types, and the lookups a section's details
// need. Rosters carry an ID, a name and a student's grade, and nothing else: contact details and
// demographics are never read out of a record (`clever-api.ts` does not even parse them).

import type {
  CleverApi, CleverCourseRecord, CleverSchoolRecord, CleverSectionRecord, CleverTermRecord, CleverUserRecord,
} from "./clever-api";
import type { CleverRole, CleverRosterMember, CleverSection } from "./types";

/** How long a school, term or course looked up is reused. */
const LOOKUP_TTL_MS = 10 * 60 * 1000;

/** A user's full name, as the district's records have it. */
export function nameOf(user: Pick<CleverUserRecord, "first" | "last">): string {
  return [user.first, user.last].filter(part => part !== "").join(" ") || "Unnamed";
}

/** The roles a user holds, in a stable order. Contacts are not a role this gatekeeper serves. */
export function rolesOf(user: CleverUserRecord): CleverRole[] {
  const roles: CleverRole[] = [];
  if (user.roles.teacher) roles.push("teacher");
  if (user.roles.student) roles.push("student");
  if (user.roles.staff) roles.push("staff");
  if (user.roles.district_admin) roles.push("district_admin");
  return roles;
}

/** The schools a user's roles list. */
export function schoolIdsOf(user: CleverUserRecord): string[] {
  const ids = new Set<string>();
  for (const role of [user.roles.student, user.roles.teacher, user.roles.staff]) {
    for (const id of role?.schools ?? []) ids.add(id);
  }
  return [...ids];
}

/** One person on a roster: ID, name, and a student's grade. */
export function toRosterMember(user: CleverUserRecord): CleverRosterMember {
  const grade = user.roles.student?.grade;
  return { id: user.id, name: nameOf(user), ...(grade === undefined ? {} : { grade }) };
}

/** Today in UTC, as `YYYY-MM-DD`. */
function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Whether a term is current or in the future: it has not ended. A term with no end counts. */
export function termIsCurrentOrFuture(term: CleverTermRecord | undefined, now = Date.now()): boolean {
  return term?.endDate === undefined || term.endDate >= today(now);
}

type Memo<T> = Map<string, { at: number; value: Promise<T> }>;

/**
 * The schools, terms and courses a district's sections name, looked up once and reused for a few
 * minutes. A failed lookup is not kept.
 */
export class CleverDirectory {
  readonly #api: CleverApi;
  readonly #schools: Memo<CleverSchoolRecord> = new Map();
  readonly #terms: Memo<CleverTermRecord | undefined> = new Map();
  readonly #courses: Memo<CleverCourseRecord | undefined> = new Map();

  constructor(api: CleverApi) {
    this.#api = api;
  }

  school(id: string): Promise<CleverSchoolRecord> {
    return this.#memo(this.#schools, id, () => this.#api.school(id));
  }

  /** A section's term, or undefined if Clever no longer has it. */
  term(id: string): Promise<CleverTermRecord | undefined> {
    return this.#memo(this.#terms, id, () => this.#api.term(id).catch(missingAsUndefined));
  }

  course(id: string): Promise<CleverCourseRecord | undefined> {
    return this.#memo(this.#courses, id, () => this.#api.course(id).catch(missingAsUndefined));
  }

  /**
   * Loads the district's schools, terms and courses whole, for a listing of many sections that
   * would otherwise look each one up.
   */
  async preload(): Promise<void> {
    const [schools, terms, courses] = await Promise.all([this.#api.schools(), this.#api.terms(), this.#api.courses()]);
    const at = Date.now();
    for (const school of schools) this.#schools.set(school.id, { at, value: Promise.resolve(school) });
    for (const term of terms) this.#terms.set(term.id, { at, value: Promise.resolve(term) });
    for (const course of courses) this.#courses.set(course.id, { at, value: Promise.resolve(course) });
  }

  async isCurrentOrFuture(section: CleverSectionRecord): Promise<boolean> {
    return termIsCurrentOrFuture(section.termId === undefined ? undefined : await this.term(section.termId));
  }

  /** The agent-facing shape of a section. */
  async toSection(section: CleverSectionRecord): Promise<CleverSection> {
    const [school, term, course] = await Promise.all([
      this.school(section.school).catch(() => ({ id: section.school, name: "Unknown school" })),
      section.termId === undefined ? undefined : this.term(section.termId),
      section.course === undefined ? undefined : this.course(section.course),
    ]);
    return {
      id: section.id,
      name: section.name,
      ...(course?.name === undefined ? {} : { courseName: course.name }),
      ...(section.subject === undefined ? {} : { subject: section.subject }),
      ...(section.grade === undefined ? {} : { grade: section.grade }),
      ...(section.period === undefined ? {} : { period: section.period }),
      school: { id: school.id, name: school.name },
      ...(term === undefined ? {} : {
        term: {
          name: term.name ?? "Term",
          ...(term.startDate === undefined ? {} : { startDate: term.startDate }),
          ...(term.endDate === undefined ? {} : { endDate: term.endDate }),
        },
      }),
    };
  }

  /** The current and future sections among `sections`, in the agent-facing shape. */
  async currentSections(sections: CleverSectionRecord[]): Promise<CleverSection[]> {
    const current = [];
    for (const section of sections) if (await this.isCurrentOrFuture(section)) current.push(section);
    return Promise.all(current.map(section => this.toSection(section)));
  }

  #memo<T>(memo: Memo<T>, id: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = memo.get(id);
    if (hit !== undefined && now - hit.at < LOOKUP_TTL_MS) return hit.value;
    const value = load();
    const entry = { at: now, value };
    memo.set(id, entry);
    value.catch(() => {
      if (memo.get(id) === entry) memo.delete(id);
    });
    return value;
  }
}

function missingAsUndefined(error: unknown): undefined {
  if ((error as { code?: unknown } | null)?.code === "not-found") return undefined;
  throw error;
}
