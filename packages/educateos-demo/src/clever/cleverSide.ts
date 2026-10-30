// The demo's Clever side (SCHO-277): what a visitor changes in Cedar Valley's district in Clever,
// the way its SIS's changes reach Clever, and which of those changes the district has yet to sync.
// Each change is a mutation of the in-page Clever fake, so Clever's events record it and the
// district's next delta sync reads it like any other. Only types come from the fakes here: the
// demo's other districts never load them.
import type { CleverDataFake, CleverEvent, PersonSeed } from "@educateos/provider-fakes";
import { CEDARVALLEY_PRINCIPALS } from "../districts/cedarvalleyPersonas.ts";
import type { DemoDistrict, DemoRoster } from "../districts/index.ts";

/** A student on a section's roster in Clever. */
export interface CleverStudent {
  /** Their ID in the district's SIS, as the fake's seed has it. */
  id: string;
  name: string;
}

/** A section as Clever lists it, with its students. */
export interface CleverSection {
  /** Its ID in the district's SIS. */
  id: string;
  /** Clever's name for it, such as "Earth Science 8 - Whitaker", which is what the district shows. */
  name: string;
  schoolId: string;
  students: readonly CleverStudent[];
}

/** A change the visitor made in Clever. */
export type CleverChange =
  | { kind: "added"; student: CleverStudent; sectionId: string }
  | { kind: "withdrawn"; student: CleverStudent }
  | { kind: "moved"; student: CleverStudent; fromSectionId: string; toSectionId: string };

/** A change made in Clever that no successful sync has brought into the district yet. */
export interface PendingChange {
  /** Unique within its {@link CleverSideStore}. */
  id: number;
  change: CleverChange;
  /** The change in a sentence, such as "Added Maya Chen to Algebra I - Whitaker". */
  summary: string;
  /** The events Clever recorded for it, which a delta sync reads. */
  events: readonly CleverEvent[];
}

/** The Clever side as it stands. */
export interface CleverSideSnapshot {
  /** The district's sections in Clever, in Clever's name order. */
  sections: readonly CleverSection[];
  /** Changes not yet synced, oldest first. */
  pending: readonly PendingChange[];
  /**
   * Whether the district has synced from Clever at all. Changes wait for that: a delta sync reads
   * Clever's events from where a complete sync left off, and the demo seeds its coursework on the
   * first sync from the people that sync brings in.
   */
  ready: boolean;
}

/** Names for the students the visitor adds, in turn. */
const NEW_STUDENTS = [
  ["Maya", "Chen"],
  ["Theo", "Brooks"],
  ["Priya", "Shah"],
  ["Jonah", "Reyes"],
  ["Nora", "Kim"],
  ["Eli", "Watts"],
] as const;

const nameOf = (person: PersonSeed): string => `${person.givenName} ${person.familyName}`;

/**
 * The district's Clever, as a presenter or visitor changes it: add a student to a section, withdraw
 * one from the district, or move one between sections. Each change is recorded as pending until a
 * successful sync, of either mode, has run after it. A store for `useSyncExternalStore`.
 */
export class CleverSideStore {
  readonly #fake: CleverDataFake;
  readonly #roster: DemoRoster;
  readonly #keep: ReadonlySet<string>;
  readonly #listeners = new Set<() => void>();
  readonly #changeListeners = new Set<(change: PendingChange) => void>();
  #pending: PendingChange[] = [];
  #snapshot: CleverSideSnapshot;
  #added = 0;
  #changes = 0;

  /**
   * @param keep Students the visitor cannot withdraw, such as the demo's own student persona,
   *   whose sign-in a withdrawal would end.
   */
  constructor(fake: CleverDataFake, roster: DemoRoster, keep: ReadonlySet<string> = new Set()) {
    this.#fake = fake;
    this.#roster = roster;
    this.#keep = keep;
    this.#snapshot = this.#read();
    roster.onSync((result) => {
      if (result.run?.outcome === "succeeded") this.#pending = [];
      this.#publish();
    });
  }

  /** Subscribes to every change of {@link getSnapshot}. Returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The Clever side now; the same object until something changes. */
  getSnapshot = (): CleverSideSnapshot => this.#snapshot;

  /** Calls `listener` with each change the visitor makes, as it is made. Returns the unsubscribe. */
  onChange(listener: (change: PendingChange) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Whether `studentId` may be withdrawn. */
  canWithdraw(studentId: string): boolean {
    return !this.#keep.has(studentId);
  }

  /** The sections `studentId` could move to from `fromSectionId`: the others at its school they are not in. */
  moveTargets(studentId: string, fromSectionId: string): CleverSection[] {
    const from = this.#snapshot.sections.find((s) => s.id === fromSectionId);
    if (from === undefined) return [];
    return this.#snapshot.sections.filter((s) => s.schoolId === from.schoolId && !s.students.some((student) => student.id === studentId));
  }

  /** Enrolls a new student in `sectionId`, at its school and grade, as a new SIS record would. */
  addStudent(sectionId: string): PendingChange {
    const section = this.#section(sectionId);
    const seed = this.#fake.seed;
    const [givenName, family] = NEW_STUDENTS[this.#added % NEW_STUDENTS.length]!;
    const round = Math.floor(this.#added / NEW_STUDENTS.length);
    const familyName = round === 0 ? family : `${family}-${round + 1}`;
    this.#added += 1;
    const id = `prn_cv-student-new-${this.#added}`;
    const classmate = seed.people.find((p) => section.studentIds.includes(p.id));
    const person: PersonSeed = {
      id,
      role: "student",
      givenName,
      familyName,
      email: `${givenName}.${familyName}.${this.#added}@${seed.domain}`.toLowerCase(),
      schoolIds: [section.schoolId],
      ...(classmate?.grade === undefined ? {} : { grade: classmate.grade }),
    };
    const events = this.#fake.addPerson(person, [sectionId]);
    const student = { id, name: nameOf(person) };
    return this.#record({ kind: "added", student, sectionId }, `Added ${student.name} to ${this.#nameOf(sectionId)}`, events);
  }

  /** Withdraws a student from the district: Clever deletes them and drops them from every section. */
  withdraw(studentId: string): PendingChange {
    if (!this.canWithdraw(studentId)) throw new RangeError(`${studentId} stays in the demo`);
    const student = this.#student(studentId);
    const events = this.#fake.removePerson(studentId);
    return this.#record({ kind: "withdrawn", student }, `Withdrew ${student.name} from the district`, events);
  }

  /** Moves a student from one section to another at the same school. */
  move(studentId: string, fromSectionId: string, toSectionId: string): PendingChange {
    if (!this.moveTargets(studentId, fromSectionId).some((s) => s.id === toSectionId)) {
      throw new RangeError(`${studentId} cannot move from ${fromSectionId} to ${toSectionId}`);
    }
    const student = this.#student(studentId);
    const events = this.#fake.moveStudent(studentId, fromSectionId, toSectionId);
    return this.#record(
      { kind: "moved", student, fromSectionId, toSectionId },
      `Moved ${student.name} from ${this.#nameOf(fromSectionId)} to ${this.#nameOf(toSectionId)}`,
      events,
    );
  }

  #section(sectionId: string) {
    const section = this.#fake.seed.sections.find((s) => s.id === sectionId);
    if (section === undefined) throw new RangeError(`Clever has no section ${sectionId}`);
    return section;
  }

  #student(studentId: string): CleverStudent {
    const person = this.#fake.seed.people.find((p) => p.id === studentId && p.role === "student");
    if (person === undefined) throw new RangeError(`Clever has no student ${studentId}`);
    return { id: person.id, name: nameOf(person) };
  }

  #nameOf(sectionId: string): string {
    const name = this.#fake.record("sections", this.#fake.idOf("sections", sectionId))?.["name"];
    return typeof name === "string" ? name : this.#section(sectionId).title;
  }

  #record(change: CleverChange, summary: string, events: readonly CleverEvent[]): PendingChange {
    this.#changes += 1;
    const pending = { id: this.#changes, change, summary, events };
    this.#pending = [...this.#pending, pending];
    this.#publish();
    for (const listener of this.#changeListeners) listener(pending);
    return pending;
  }

  #read(): CleverSideSnapshot {
    const seed = this.#fake.seed;
    const people = new Map(seed.people.map((p) => [p.id, p]));
    const sections = seed.sections
      .filter((s) => (s.status ?? "active") === "active")
      .map((s): CleverSection => ({
        id: s.id,
        name: this.#nameOf(s.id),
        schoolId: s.schoolId,
        students: s.studentIds.flatMap((id) => {
          const person = people.get(id);
          return person === undefined || (person.status ?? "active") !== "active" ? [] : [{ id, name: nameOf(person) }];
        }),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    return { sections, pending: this.#pending, ready: this.#roster.synced() };
  }

  #publish(): void {
    this.#snapshot = this.#read();
    for (const listener of this.#listeners) listener();
  }
}

const sides = new WeakMap<CleverDataFake, CleverSideStore>();

/**
 * The one {@link CleverSideStore} of a booted district whose roster comes from the in-page Clever,
 * made on first use so every persona shares it, or undefined for any other district. The demo's
 * own student stays: withdrawing them would end the visitor's way in as a student.
 */
export function cleverSideOf(district: DemoDistrict): CleverSideStore | undefined {
  if (!isCleverDistrict(district)) return undefined;
  let side = sides.get(district.clever);
  if (side === undefined) {
    side = new CleverSideStore(district.clever, district.roster, new Set([CEDARVALLEY_PRINCIPALS.student]));
    sides.set(district.clever, side);
  }
  return side;
}

const isCleverDistrict = (district: DemoDistrict): district is DemoDistrict & { clever: CleverDataFake; roster: DemoRoster } =>
  "clever" in district && district.roster !== undefined;
