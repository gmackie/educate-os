import { z } from "zod";
import {
  OfferingId,
  PrincipalId,
  EducateOsError,
  type Action,
  type Caller,
  type DistrictDirectorySnapshot,
  type ResourceRef,
  type TermState,
} from "@educateos/contracts";
import type { AcademicStore } from "@educateos/academics";
import type { PolicyDecider } from "@educateos/policy";
import {
  computeGradebook,
  gradebookCsv,
  GradebookColumn,
  GradebookRow,
  GradebookSettings,
  DEFAULT_GRADEBOOK_SETTINGS,
  GradeMarker,
  GradeMarkerRecord,
  type GradebookStudent,
} from "./gradebook.ts";
import { AssignmentId } from "./model.ts";
import type { AssessmentRecordStore } from "./store.ts";

/** Who last changed an offering's gradebook settings, and when. */
export const GradebookUpdate = z.strictObject({ by: PrincipalId, at: z.iso.datetime() });
/** A gradebook update. */
export type GradebookUpdate = z.infer<typeof GradebookUpdate>;

/**
 * An offering's stored gradebook: its settings (absent until a teacher saves some), the revision
 * optimistic concurrency checks settings changes against, and the markers on its cells.
 */
export interface StoredGradebook {
  /** 0 until settings are first saved; increases by one with each save. */
  revision: number;
  settings?: GradebookSettings;
  updated?: GradebookUpdate;
  markers: GradeMarkerRecord[];
}

/** Where each offering's gradebook settings and markers are kept. */
export interface GradebookStore {
  /** An offering's gradebook, or revision 0 with no settings and no markers. */
  load(offeringId: OfferingId): Promise<StoredGradebook>;
  /** Replaces an offering's settings if its revision is still `expectedRevision`, else throws `conflict`. Returns the new revision. */
  saveSettings(offeringId: OfferingId, settings: GradebookSettings, updated: GradebookUpdate, expectedRevision: number): Promise<number>;
  /** Sets the marker on one cell, replacing any there, or clears it with `undefined`. */
  setMarker(offeringId: OfferingId, assignmentId: AssignmentId, studentPrincipalId: PrincipalId, marker: GradeMarkerRecord | undefined): Promise<void>;
}

/** A {@link GradebookStore} held in memory, for tests and the local harness. */
export class InMemoryGradebookStore implements GradebookStore {
  readonly #gradebooks = new Map<OfferingId, StoredGradebook>();

  async load(offeringId: OfferingId): Promise<StoredGradebook> {
    return structuredClone(this.#gradebooks.get(offeringId) ?? { revision: 0, markers: [] });
  }

  async saveSettings(offeringId: OfferingId, settings: GradebookSettings, updated: GradebookUpdate, expectedRevision: number): Promise<number> {
    const current = this.#gradebooks.get(offeringId) ?? { revision: 0, markers: [] };
    if (current.revision !== expectedRevision) throw settingsConflict();
    const revision = current.revision + 1;
    this.#gradebooks.set(offeringId, { ...current, revision, settings: GradebookSettings.parse(settings), updated: GradebookUpdate.parse(updated) });
    return revision;
  }

  async setMarker(offeringId: OfferingId, assignmentId: AssignmentId, studentPrincipalId: PrincipalId, marker: GradeMarkerRecord | undefined): Promise<void> {
    const current = this.#gradebooks.get(offeringId) ?? { revision: 0, markers: [] };
    const others = current.markers.filter((m) => m.assignmentId !== assignmentId || m.studentPrincipalId !== studentPrincipalId);
    this.#gradebooks.set(offeringId, { ...current, markers: marker === undefined ? others : [...others, GradeMarkerRecord.parse(marker)] });
  }
}

/** The `conflict` a settings save over a stale revision answers. */
export function settingsConflict(): EducateOsError {
  return new EducateOsError("conflict", "The gradebook settings changed while you were editing them; reload them and try again.");
}

/** An offering's gradebook as its teachers and administrators see it: every enrolled student's row. */
export const GradebookView = z.strictObject({
  offeringId: OfferingId,
  revision: z.int().nonnegative(),
  settings: GradebookSettings,
  updated: GradebookUpdate.optional(),
  columns: z.array(GradebookColumn),
  rows: z.array(GradebookRow),
});
/** A gradebook view. */
export type GradebookView = z.infer<typeof GradebookView>;

/** A student's own gradebook row in one offering, with the columns and settings that explain it. */
export const StudentGradeSummary = z.strictObject({
  offeringId: OfferingId,
  settings: GradebookSettings,
  columns: z.array(GradebookColumn),
  row: GradebookRow,
});
/** A student grade summary. */
export type StudentGradeSummary = z.infer<typeof StudentGradeSummary>;

/** A settings change: the whole new settings, and the revision they were edited from. */
export const GradebookSettingsInput = z.strictObject({ revision: z.int().nonnegative(), settings: GradebookSettings });
/** A settings change. */
export type GradebookSettingsInput = z.infer<typeof GradebookSettingsInput>;

/** Setting or clearing (`null`) the marker on one student's assignment. */
export const GradeMarkerInput = z.strictObject({ assignmentId: AssignmentId, studentPrincipalId: PrincipalId, marker: GradeMarker.nullable() });
/** A marker change. */
export type GradeMarkerInput = z.infer<typeof GradeMarkerInput>;

/** A gradebook exported as CSV. */
export const GradebookCsvExport = z.strictObject({ fileName: z.string(), mediaType: z.literal("text/csv"), csv: z.string() });
/** A gradebook CSV export. */
export type GradebookCsvExport = z.infer<typeof GradebookCsvExport>;

/** What a {@link GradebookService} is built from. */
export interface GradebookServiceOptions {
  /** The district's assessment records: assignments and official grade versions are read, never written. */
  records: AssessmentRecordStore;
  /** Where gradebook settings and markers are kept. */
  gradebooks: GradebookStore;
  /** The district's academic directory, read for offerings, terms, enrollments and names. */
  directory: AcademicStore;
  /** Decides and audits every access. */
  policy: PolicyDecider;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** An offering as policy sees it, with its roster. */
interface OfferingContext {
  scope: Extract<ResourceRef["scope"], { level: "offering" }>;
  termState: TermState;
  snapshot: DistrictDirectorySnapshot;
}

/**
 * Each offering's gradebook (SCHO-187), authorized by the policy engine as a `gradebook` resource
 * at the offering:
 *
 * - The whole class's grid is `teacher-only`: its teachers and co-teachers read and export it, and
 *   administrators over the offering read it. Only a teacher acting directly changes its settings
 *   or markers, which change computed totals and never an official grade.
 * - A student's own row is a `course` record they own, readable by them alone (and by staff), even
 *   after leaving the offering. A student never reads the class grid.
 *
 * A read the caller may not make answers `not-found`; a change they may see but not make answers
 * `forbidden`.
 */
export class GradebookService {
  readonly #records: AssessmentRecordStore;
  readonly #gradebooks: GradebookStore;
  readonly #directory: AcademicStore;
  readonly #policy: PolicyDecider;
  readonly #now: () => Date;

  constructor(options: GradebookServiceOptions) {
    this.#records = options.records;
    this.#gradebooks = options.gradebooks;
    this.#directory = options.directory;
    this.#policy = options.policy;
    this.#now = options.now ?? (() => new Date());
  }

  /** The offering's grid: a row for each actively enrolled student, by name. */
  async grid(caller: Caller, rawOfferingId: OfferingId): Promise<GradebookView> {
    const offeringId = parse(OfferingId, rawOfferingId);
    const at = await this.#offering(offeringId);
    await this.#requireGrid(caller, at, "read");
    return this.#view(offeringId, at);
  }

  /**
   * Replaces the offering's settings, if they are still the revision the teacher edited. Every
   * assignment a group names must be one of the offering's.
   */
  async updateSettings(caller: Caller, rawOfferingId: OfferingId, rawInput: GradebookSettingsInput): Promise<GradebookView> {
    const offeringId = parse(OfferingId, rawOfferingId);
    const input = parse(GradebookSettingsInput, rawInput);
    const at = await this.#offering(offeringId);
    await this.#requireGrid(caller, at, "update");
    const { state } = await this.#records.load();
    const assignments = new Set(state.assignments.filter((a) => a.offeringId === offeringId).map((a) => a.id));
    if (input.settings.groups.some((g) => g.assignmentIds.some((id) => !assignments.has(id)))) {
      throw new EducateOsError("validation-failed", "A group names an assignment that is not in this class.");
    }
    await this.#gradebooks.saveSettings(offeringId, input.settings, { by: caller.principal.principalId, at: this.#now().toISOString() }, input.revision);
    return this.#view(offeringId, at);
  }

  /** Sets or clears the marker on one enrolled student's assignment, returning their recomputed row. */
  async setMarker(caller: Caller, rawOfferingId: OfferingId, rawInput: GradeMarkerInput): Promise<GradebookRow> {
    const offeringId = parse(OfferingId, rawOfferingId);
    const input = parse(GradeMarkerInput, rawInput);
    const at = await this.#offering(offeringId);
    await this.#requireGrid(caller, at, "update");
    const { state } = await this.#records.load();
    if (!state.assignments.some((a) => a.id === input.assignmentId && a.offeringId === offeringId)) {
      throw new EducateOsError("validation-failed", "That assignment is not in this class.");
    }
    const student = studentsOf(at.snapshot, offeringId, { includeInactive: true }).find((s) => s.principalId === input.studentPrincipalId);
    if (student === undefined) throw new EducateOsError("validation-failed", "That student is not in this class.");
    const marker = input.marker === null
      ? undefined
      : { assignmentId: input.assignmentId, studentPrincipalId: input.studentPrincipalId, marker: input.marker, setBy: caller.principal.principalId, setAt: this.#now().toISOString() };
    await this.#gradebooks.setMarker(offeringId, input.assignmentId, input.studentPrincipalId, marker);
    const { rows } = await this.#compute(offeringId, [student]);
    return rows[0]!;
  }

  /** The grid as CSV, for the offering's teachers and co-teachers. See `gradebookCsv` for the layout. */
  async exportCsv(caller: Caller, rawOfferingId: OfferingId): Promise<GradebookCsvExport> {
    const offeringId = parse(OfferingId, rawOfferingId);
    const at = await this.#offering(offeringId);
    await this.#requireGrid(caller, at, "export");
    const view = await this.#view(offeringId, at);
    const offering = at.snapshot.offerings.find((o) => o.id === offeringId)!;
    const course = at.snapshot.courses.find((c) => c.id === offering.courseId);
    const slug = `${course?.title ?? "class"}-${offering.sectionName}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "class";
    return { fileName: `${slug}-gradebook.csv`, mediaType: "text/csv", csv: gradebookCsv(view, view.settings) };
  }

  /**
   * The caller's own row in an offering they are or were enrolled in as a student. Anyone else,
   * and any other offering, answers `not-found`.
   */
  async studentSummary(caller: Caller, rawOfferingId: OfferingId): Promise<StudentGradeSummary> {
    const offeringId = parse(OfferingId, rawOfferingId);
    const at = await this.#offering(offeringId);
    const student = studentsOf(at.snapshot, offeringId, { includeInactive: true }).find((s) => s.principalId === caller.principal.principalId);
    const target = gradebookTarget(at, "course", caller.principal.principalId);
    if (student === undefined || (await this.#decide(caller, "read", target)) !== "allow") throw notFound(offeringId);
    const { settings, columns, rows } = await this.#compute(offeringId, [student]);
    return { offeringId, settings, columns, row: rows[0]! };
  }

  async #view(offeringId: OfferingId, at: OfferingContext): Promise<GradebookView> {
    const { stored, settings, columns, rows } = await this.#compute(offeringId, studentsOf(at.snapshot, offeringId, { includeInactive: false }));
    return { offeringId, revision: stored.revision, settings, ...(stored.updated === undefined ? {} : { updated: stored.updated }), columns, rows };
  }

  async #compute(offeringId: OfferingId, students: readonly GradebookStudent[]) {
    const [{ state }, stored] = await Promise.all([this.#records.load(), this.#gradebooks.load(offeringId)]);
    const settings = stored.settings ?? DEFAULT_GRADEBOOK_SETTINGS;
    const { columns, rows } = computeGradebook({
      offeringId,
      assignments: state.assignments,
      // Official versions only: proposals and suggested scores are other records, never read here.
      versions: state.gradeVersions.filter((v) => v.offeringId === offeringId),
      settings,
      markers: stored.markers,
      students,
    });
    return { stored, settings, columns, rows };
  }

  /** Requires `action` on the class grid: `not-found` if the caller may not even read it, `forbidden` if they may read but not do this. */
  async #requireGrid(caller: Caller, at: OfferingContext, action: Action): Promise<void> {
    const target = gradebookTarget(at, "teacher-only", undefined);
    if ((await this.#decide(caller, "read", target)) !== "allow") throw notFound(at.scope.offeringId);
    if (action !== "read" && (await this.#decide(caller, action, target)) !== "allow") {
      throw new EducateOsError("forbidden", action === "export" ? "Only the class's teachers can export its gradebook." : "Only the class's teacher can change its gradebook.");
    }
  }

  async #decide(caller: Caller, action: Action, target: { resource: ResourceRef; termState: TermState }) {
    const { decision } = await this.#policy.decide(
      { subject: caller.principal, action, resource: target.resource, context: { channel: caller.channel, termState: target.termState } },
      { correlationId: caller.correlationId ?? crypto.randomUUID() },
    );
    return decision.effect;
  }

  async #offering(offeringId: OfferingId): Promise<OfferingContext> {
    const { snapshot } = await this.#directory.load();
    const offering = snapshot.offerings.find((o) => o.id === offeringId);
    if (offering === undefined) throw notFound(offeringId);
    const term = snapshot.terms.find((t) => t.id === offering.termId);
    if (term === undefined) throw new Error(`term ${offering.termId} is missing from the directory`);
    return {
      scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
      termState: term.state,
      snapshot,
    };
  }
}

/** The offering's student enrollments as gradebook rows, by name then ID. */
function studentsOf(snapshot: DistrictDirectorySnapshot, offeringId: OfferingId, options: { includeInactive: boolean }): GradebookStudent[] {
  const names = new Map(snapshot.principals.map((p) => [p.id, p.displayName]));
  const seen = new Set<PrincipalId>();
  const students: GradebookStudent[] = [];
  for (const e of snapshot.enrollments) {
    if (e.offeringId !== offeringId || e.role !== "student" || (!options.includeInactive && e.status !== "active") || seen.has(e.principalId)) continue;
    seen.add(e.principalId);
    students.push({ principalId: e.principalId, displayName: names.get(e.principalId) ?? "" });
  }
  return students.toSorted((a, b) => a.displayName.localeCompare(b.displayName, "en") || (a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : 0));
}

/** The gradebook as policy sees it: the class grid (`teacher-only`, unowned) or one student's row (`course`, theirs). */
function gradebookTarget(at: OfferingContext, classification: "teacher-only" | "course", owner: PrincipalId | undefined) {
  return {
    resource: {
      kind: "gradebook",
      id: at.scope.offeringId,
      scope: at.scope,
      classification,
      ...(owner === undefined ? {} : { ownerPrincipalId: owner }),
    } satisfies ResourceRef,
    termState: at.termState,
  };
}

function notFound(offeringId: string): EducateOsError {
  return new EducateOsError("not-found", `The gradebook of ${offeringId} was not found.`);
}

/** Parses caller input, answering `validation-failed` rather than a raw Zod error. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  return parsed.data;
}
