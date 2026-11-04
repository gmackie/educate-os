// The district course library (SCHO-331): OCS courses an administrator imports from signed bundles
// (RFC 0001 §13.2, §14), which teachers then install into their classes (course-install.ts). The
// library itself is the OCS package's immutable `DurableObjectPackageLibrary` in the district's own
// storage, holding every package and activity export with the signature it was accepted with; beside
// it the district keeps an index of the course versions imported, with the outline a teacher browses.
//
// Trust. A bundle is opened against the district's `PublisherTrust`, the deployment's committed pin
// of publisher domains and their public keys (`COURSE_LIBRARY_TRUST`), never anything a request
// carries. The district's own domains (`localDomains`) publish unsigned; every other part needs its
// publisher's signature by a pinned key. The library checks every part again as it stores it.
import { EducateOsError, PrincipalId } from "@educateos/contracts";
import {
  type ActivityExportSource,
  composeCourse,
  type CourseInstallPlan,
  type OcsFiles,
  OcsPackageId,
  openBundle,
  type PackageSource,
  planBundleInstall,
  planCourseInstall,
  publisherDomain,
  publisherExportPolicy,
  publisherPolicy,
  type PublishedActivityExport,
  type PublishedPackage,
  type PublisherTrust,
  readActivityExport,
  readPackage,
  resolveActivityExports,
  resolveCourse,
} from "@educateos/ocs";
import type { ExportPublicationPolicy, PublicationPolicy } from "@educateos/ocs/durable-object-library";
import { z } from "zod";

/** The publisher keys a district accepts OCS courses under, re-exported for the district Worker's `COURSE_LIBRARY_TRUST`. */
export { PublisherTrust } from "@educateos/ocs";
import { CoursePackageVersion, LibraryCourseBody, type CourseStandardBody } from "./routes.ts";

/**
 * The library a {@link CourseLibraryStore} holds: a package and export source the resolver reads,
 * and the one place packages and exports are published to, each under the district's publication
 * policy. `DurableObjectPackageLibrary` is one.
 */
export interface CourseLibrary extends PackageSource, ActivityExportSource {
  /** Publishes a package version under the policy. Publishing it again with the same content is a no-op. */
  publish(files: OcsFiles, signature?: unknown): Promise<PublishedPackage>;
  /** Publishes an activity export version under the export policy, as {@link publish}. */
  publishExport(text: string, signature?: unknown): Promise<PublishedActivityExport>;
}

/** The policies a library admits publications under: `publisherPolicy` and `publisherExportPolicy` over one trust. */
export interface LibraryPolicies {
  policy: PublicationPolicy;
  exportPolicy: ExportPublicationPolicy;
}

/** A course version in the library's index, as the admin console lists it. */
export const LibraryCourse = LibraryCourseBody;
/** A library course version. */
export type LibraryCourse = LibraryCourseBody;

/** The local definition a class holds for a portable activity, and what it was made with (SCHO-331). */
export const InstalledDefinition = z.strictObject({
  /** The plan's import key, `id@version`. */
  key: z.string().min(1).max(400),
  ref: z.strictObject({ id: z.string(), version: z.string(), digest: z.string() }),
  definition: z.strictObject({ definitionId: z.string(), version: z.int().positive() }),
  status: z.enum(["draft", "published"]),
  /** The rubric release signed from the export's rubric, which its assignments pin. */
  rubric: z.strictObject({ rubricId: z.string(), version: z.int().positive() }).optional(),
  /** The release each of the export's readings became, by reading ID. */
  readings: z.record(z.string(), z.strictObject({ resourceId: z.string(), version: z.string() })),
});
/** A class's local definition of a portable activity. */
export type InstalledDefinition = z.infer<typeof InstalledDefinition>;

/** What a class holds of one installed unit. */
export const InstalledUnit = z.strictObject({
  unitKey: z.string().min(1).max(500),
  /** `exists`: the class already had a module of this title, so the unit was skipped. */
  status: z.enum(["exists", "installing", "installed"]),
  moduleId: z.string().optional(),
  /** The items added, by item key, with the activity and assignment an activity item became. */
  items: z.record(z.string(), z.strictObject({
    activityId: z.string().optional(),
    assignmentId: z.string().optional(),
    /** Whether the activity is placed in the module yet. */
    placed: z.boolean().optional(),
  })),
});
/** An installed unit. */
export type InstalledUnit = z.infer<typeof InstalledUnit>;

/** One course version installed (or being installed) in a class. */
export const InstalledCourse = z.strictObject({
  packageId: OcsPackageId,
  version: CoursePackageVersion,
  digest: z.string(),
  /**
   * The install is the review: the class's teacher previewed the course and chose to install it,
   * which publishes its imported drafts for that class (RFC 0001 §13.1). Who, and when.
   */
  reviewedBy: PrincipalId,
  reviewedAt: z.string(),
  units: z.array(InstalledUnit),
  completedAt: z.string().optional(),
});
/** A course installed in a class. */
export type InstalledCourse = z.infer<typeof InstalledCourse>;

/**
 * Everything one class holds from the course library: its local definitions of portable
 * activities (reused by every later install in the class) and the courses installed in it.
 */
export const OfferingCourseInstalls = z.strictObject({
  offeringId: z.string(),
  /** 0 before anything is stored; each commit adds one. */
  revision: z.int().nonnegative(),
  definitions: z.array(InstalledDefinition).max(2000),
  courses: z.array(InstalledCourse).max(200),
});
/** A class's course installs. */
export type OfferingCourseInstalls = z.infer<typeof OfferingCourseInstalls>;

/** Where the district keeps its course library and each class's installs. */
export interface CourseLibraryStore {
  /** The library, admitting publications under `policies`. */
  library(policies: LibraryPolicies): CourseLibrary;
  /** Every imported course version, oldest first. */
  listCourses(): Promise<LibraryCourse[]>;
  /**
   * Adds a course version to the index unless that version is already there, atomically, and
   * returns the entry now indexed for it: `course`, or the one already there.
   */
  addCourse(course: LibraryCourse): Promise<LibraryCourse>;
  /** What a class holds from the library, or undefined if nothing yet. */
  loadInstalls(offeringId: string): Promise<OfferingCourseInstalls | undefined>;
  /**
   * Stores a class's installs (whose revision is one more than `expectedRevision`).
   *
   * @throws EducateOsError `conflict` if the stored revision is not `expectedRevision`.
   */
  commitInstalls(installs: OfferingCourseInstalls, expectedRevision: number): Promise<void>;
}

/** A {@link CourseLibrary} in memory, under the given policies, as the Durable Object library behaves. */
class InMemoryCourseLibrary implements CourseLibrary {
  readonly #packages: Map<string, { files: OcsFiles; digest: string }>;
  readonly #exports: Map<string, PublishedActivityExport>;
  readonly #policies: LibraryPolicies;

  constructor(packages: Map<string, { files: OcsFiles; digest: string }>, exports: Map<string, PublishedActivityExport>, policies: LibraryPolicies) {
    this.#packages = packages;
    this.#exports = exports;
    this.#policies = policies;
  }

  async publish(files: OcsFiles, signature?: unknown): Promise<PublishedPackage> {
    const pkg = await readPackage(files);
    await this.#policies.policy(pkg, signature);
    const key = `${pkg.manifest.id}@${pkg.manifest.version}`;
    const existing = this.#packages.get(key);
    if (existing !== undefined && existing.digest !== pkg.digest) throw new EducateOsError("conflict", `${key} is already published with different content; publish a new version instead`);
    if (existing === undefined) this.#packages.set(key, { files: { ...files }, digest: pkg.digest });
    return { files: { ...files }, digest: pkg.digest };
  }

  async listVersions(id: OcsPackageId): Promise<readonly string[]> {
    return [...this.#packages.keys()].filter((key) => key.startsWith(`${id}@`)).map((key) => key.slice(id.length + 1));
  }

  async getPackage(id: OcsPackageId, version: string): Promise<PublishedPackage | undefined> {
    const found = this.#packages.get(`${id}@${version}`);
    return found === undefined ? undefined : { files: { ...found.files }, digest: found.digest };
  }

  async publishExport(text: string, signature?: unknown): Promise<PublishedActivityExport> {
    const parsed = await readActivityExport(text);
    await this.#policies.exportPolicy(parsed, signature);
    const key = `${parsed.export.id}@${parsed.export.version}`;
    const existing = this.#exports.get(key);
    if (existing !== undefined && existing.digest !== parsed.digest) throw new EducateOsError("conflict", `${key} is already published with different content; publish a new version instead`);
    if (existing === undefined) this.#exports.set(key, { text, digest: parsed.digest });
    return { text, digest: parsed.digest };
  }

  async listExportVersions(id: string): Promise<readonly string[]> {
    return [...this.#exports.keys()].filter((key) => key.startsWith(`${id}@`)).map((key) => key.slice(id.length + 1));
  }

  async getExport(id: string, version: string): Promise<PublishedActivityExport | undefined> {
    const found = this.#exports.get(`${id}@${version}`);
    return found === undefined ? undefined : { ...found };
  }
}

/** A {@link CourseLibraryStore} in memory, for tests and development. Stores copies, never references. */
export class InMemoryCourseLibraryStore implements CourseLibraryStore {
  readonly #packages = new Map<string, { files: OcsFiles; digest: string }>();
  readonly #exports = new Map<string, PublishedActivityExport>();
  readonly #courses: LibraryCourse[] = [];
  readonly #installs = new Map<string, OfferingCourseInstalls>();

  library(policies: LibraryPolicies): CourseLibrary {
    return new InMemoryCourseLibrary(this.#packages, this.#exports, policies);
  }

  async listCourses(): Promise<LibraryCourse[]> {
    return structuredClone(this.#courses);
  }

  async addCourse(course: LibraryCourse): Promise<LibraryCourse> {
    const parsed = LibraryCourse.parse(course);
    const existing = this.#courses.find((c) => c.packageId === parsed.packageId && c.version === parsed.version);
    if (existing !== undefined) return structuredClone(existing);
    this.#courses.push(structuredClone(parsed));
    return structuredClone(parsed);
  }

  async loadInstalls(offeringId: string): Promise<OfferingCourseInstalls | undefined> {
    const found = this.#installs.get(offeringId);
    return found === undefined ? undefined : structuredClone(found);
  }

  async commitInstalls(installs: OfferingCourseInstalls, expectedRevision: number): Promise<void> {
    const parsed = OfferingCourseInstalls.parse(installs);
    if ((this.#installs.get(parsed.offeringId)?.revision ?? 0) !== expectedRevision) {
      throw new EducateOsError("conflict", "The class's course install changed while this request was in progress; try again.");
    }
    this.#installs.set(parsed.offeringId, structuredClone(parsed));
  }
}

/** A competency's code for a teacher: the last part of its URI, which catalog URIs make its code. */
export const standardCode = (competencyUri: string): string => competencyUri.split(/[:/]/).findLast((part) => part !== "") ?? competencyUri;

/** A course's standards as a teacher reads them. */
export const standardsBody = (standards: readonly { frameworkKey: string; competencyUri: string }[]): CourseStandardBody[] =>
  standards.map(({ frameworkKey, competencyUri }) => ({ frameworkKey, competencyUri, code: standardCode(competencyUri) }));

/** The library's index entry for a planned course. */
function libraryEntry(plan: CourseInstallPlan, summary: string | undefined, digest: string, signed: boolean, actor: { by: PrincipalId; at: string }): LibraryCourse {
  const { course } = plan;
  return LibraryCourse.parse({
    packageId: course.packageId,
    version: course.version,
    digest,
    title: course.title,
    ...(summary === undefined ? {} : { summary }),
    ...(course.subject === undefined ? {} : { subject: course.subject }),
    ...(course.gradeBand === undefined ? {} : { gradeBand: course.gradeBand }),
    language: course.language,
    publisher: { domain: publisherDomain(course.packageId), signed },
    standards: standardsBody(course.standards),
    units: plan.units.map((unit) => ({
      key: unit.key,
      title: unit.title,
      ...(unit.summary === undefined ? {} : { summary: unit.summary }),
      standards: standardsBody(unit.standards),
      activities: unit.items.filter((item) => item.kind === "activity").length,
      pages: unit.items.filter((item) => item.kind === "page").length,
      teacherNotes: unit.items.filter((item) => item.kind === "teacher-note").length,
      resources: unit.items.filter((item) => item.kind === "resource").length,
    })),
    activities: plan.units.reduce((total, unit) => total + unit.items.filter((item) => item.kind === "activity").length, 0),
    imported: actor,
  });
}

/** The policies of a district's library over its trust, at the time `now` gives. */
export const libraryPolicies = (trust: PublisherTrust, now: () => Date): LibraryPolicies => ({
  policy: publisherPolicy(trust, now),
  exportPolicy: publisherExportPolicy(trust, now),
});

/**
 * Imports a signed course bundle into the district's library: opens it against the district's
 * trust (every digest and every signature checked, nothing in the bundle trusted), plans its
 * install from the bundle alone (so a course that would not install is refused here), publishes
 * every package and export with its signature into the library (which checks each again), and
 * indexes the course. Importing a version again changes nothing and answers with the indexed
 * entry; the same version with other content is refused, since a published version never changes.
 *
 * @throws EducateOsError `unavailable` if the district pins no course publishers,
 *   `validation-failed` for a malformed or tampered bundle, `unauthenticated` for a part whose
 *   signature is missing or not by a pinned key, `conflict` for a version already imported with
 *   other content, and OcsError for a course that does not resolve, compose or plan.
 */
export async function importCourseBundle(
  store: CourseLibraryStore,
  trust: PublisherTrust | undefined,
  bundle: unknown,
  actor: { by: PrincipalId; at: string },
): Promise<LibraryCourse> {
  if (trust === undefined) {
    throw new EducateOsError("unavailable", "This district pins no course publishers, so it cannot import course bundles.");
  }
  const now = new Date(actor.at);
  const opened = await openBundle(bundle, trust, now);
  const plan = await planBundleInstall(opened);
  const library = store.library(libraryPolicies(trust, () => now));
  // The opened bundle has checked the shape; only its parts' signatures are read here.
  const parts = bundle as { packages: { files: Record<string, string>; signature?: unknown }[]; exports: { text: string; signature?: unknown }[] };
  for (const entry of parts.packages) await library.publish(entry.files, entry.signature);
  for (const entry of parts.exports) await library.publishExport(entry.text, entry.signature);
  const root = await readPackage((await library.getPackage(opened.course.id, opened.course.version))!.files);
  const course = libraryEntry(plan, root.manifest.summary, opened.course.digest, opened.signed.get(`${opened.course.id}@${opened.course.version}`) ?? false, actor);
  const indexed = await store.addCourse(course);
  if (indexed.digest !== course.digest) throw new EducateOsError("conflict", `${course.packageId} ${course.version} is already in the library with other content.`);
  return indexed;
}

/**
 * Plans installing a library course version, from the library alone: the course resolved with its
 * own lockfile, composed, and every export it names fetched and verified against the digest the
 * course pins. The library checked every part when it was imported; the resolver checks every
 * digest again here, so a row altered in storage is refused.
 *
 * @throws EducateOsError `not-found` if the library has no such version, and OcsError as
 *   `resolveCourse`, `composeCourse`, `resolveActivityExports` and `planCourseInstall`.
 */
export async function planLibraryInstall(library: CourseLibrary, packageId: string, version: string): Promise<CourseInstallPlan> {
  const id = OcsPackageId.safeParse(packageId);
  const published = id.success ? await library.getPackage(id.data, version) : undefined;
  if (published === undefined) throw new EducateOsError("not-found", "That course is not in the district's course library.");
  const root = await readPackage(published.files);
  if (root.digest !== published.digest) throw new EducateOsError("unavailable", "The library's copy of that course does not match its fingerprint.");
  const course = composeCourse(await resolveCourse(root, library, { locked: root.lock }));
  return planCourseInstall(course, await resolveActivityExports(course, library));
}

/** The latest version of each course in the index, by semantic version. */
export function latestCourses(courses: readonly LibraryCourse[]): LibraryCourse[] {
  const order = (version: string) => version.split(".").map(Number);
  const newer = (a: string, b: string) => {
    const [x, y] = [order(a), order(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
    return false;
  };
  const latest = new Map<string, LibraryCourse>();
  for (const course of courses) {
    const current = latest.get(course.packageId);
    if (current === undefined || newer(course.version, current.version)) latest.set(course.packageId, course);
  }
  return [...latest.values()];
}
