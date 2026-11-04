// Installs the educateos.io sample courses (SCHO-329) into a district through its typed API alone
// (SCHO-334), as its people would: the administrator approves the standards the courses align to and
// imports each signed bundle into the district's course library, and each class's teacher adds their
// course to the class from it. Every call goes through a `DistrictApiClient` from `actAs`, so the same
// installer runs in-process (the harness, the in-browser demo, a demo district's showcase route) and
// over HTTP. It only adds: the district checks every bundle's signatures against its own pin, a unit
// whose title the class already has (the showcase's first modules) is skipped, and a rerun finds the
// library and every class's install complete and does nothing.
import type { DistrictApiClient, RouteResponse } from "@educateos/api-client";
import type { PrincipalId } from "@educateos/contracts";
import type { Showcase } from "@educateos/fixtures";

/** A committed course bundle, `educateos.ocs-bundle.v1`, and the course version it carries. */
export interface SampleCourseBundle {
  packageId: string;
  version: string;
  /** The bundle as committed, passed to `admin.importCourseBundle` unchanged. */
  bundle: unknown;
}

/** The sample courses committed under `curriculum/bundles/educateos.io/`, each loaded only when asked for. */
const BUNDLES: Readonly<Record<string, () => Promise<{ default: unknown }>>> = {
  "educateos.io/biology-1": () => import("../../../curriculum/bundles/educateos.io/biology-1/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/english-8": () => import("../../../curriculum/bundles/educateos.io/english-8/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/english-9": () => import("../../../curriculum/bundles/educateos.io/english-9/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/grade-1-mathematics": () => import("../../../curriculum/bundles/educateos.io/grade-1-mathematics/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/grade-1-reading-foundations": () => import("../../../curriculum/bundles/educateos.io/grade-1-reading-foundations/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/grade-4-english-language-arts": () => import("../../../curriculum/bundles/educateos.io/grade-4-english-language-arts/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/grade-4-mathematics": () => import("../../../curriculum/bundles/educateos.io/grade-4-mathematics/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/grade-5-science": () => import("../../../curriculum/bundles/educateos.io/grade-5-science/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/kindergarten-science-weather-watchers": () => import("../../../curriculum/bundles/educateos.io/kindergarten-science-weather-watchers/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/mathematics-7": () => import("../../../curriculum/bundles/educateos.io/mathematics-7/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/united-states-history": () => import("../../../curriculum/bundles/educateos.io/united-states-history/1.0.0.json", { with: { type: "json" } }),
  "educateos.io/world-history-7": () => import("../../../curriculum/bundles/educateos.io/world-history-7/1.0.0.json", { with: { type: "json" } }),
};

/** The package IDs of the committed sample courses. */
export const SAMPLE_COURSE_IDS: readonly string[] = Object.keys(BUNDLES);

/**
 * Loads the committed bundles of `packageIds` (every sample course by default), in that order.
 * Bundlers split each into its own chunk, so nothing is loaded until this is called.
 *
 * @throws Error for a package ID with no committed bundle.
 */
export async function loadSampleCourseBundles(packageIds: readonly string[] = SAMPLE_COURSE_IDS): Promise<SampleCourseBundle[]> {
  return Promise.all(packageIds.map(async (packageId) => {
    const load = BUNDLES[packageId];
    if (load === undefined) throw new Error(`no committed sample course ${packageId}`);
    const bundle = (await load()).default;
    const { course } = bundle as { course: { id: string; version: string } };
    return { packageId: course.id, version: course.version, bundle };
  }));
}

/** What {@link installSampleCourses} did for one course. */
export interface SampleCourseInstall {
  packageId: string;
  version: string;
  /** The showcase class it continues. */
  offeringId: string;
  /** Whether this run imported it into the library (false: it was there already). */
  imported: boolean;
  /** Units this run installed. */
  unitsInstalled: number;
  /** Units the class already had a module for, so the install skipped them. */
  unitsSkipped: number;
  /** Of the units this run installed, their pages, teacher-only notes and activities. */
  pages: number;
  teacherNotes: number;
  activities: number;
  /** Modules of the course this run published. */
  published: number;
  /** Whether every unit of the course is now in the class. */
  done: boolean;
}

/** What {@link installSampleCourses} did. */
export interface SampleCoursesSummary {
  standardsApproved: number;
  courses: SampleCourseInstall[];
  /** Everything the run imported or installed; 0 when it found every course in place. */
  created: number;
  /** The courses `maxCourses` left for a later run (or request), which finds those already done and does the rest. */
  pending: string[];
}

/** How {@link installSampleCourses} reaches the district and what it installs. */
export interface InstallSampleCoursesOptions {
  /** The bundles to import and install, such as {@link loadSampleCourseBundles}'s. */
  bundles: readonly SampleCourseBundle[];
  /** The district administrator who approves standards and imports the bundles. */
  adminId: PrincipalId;
  /** A client signed in as `principalId`. Called once per person per run. */
  actAs: (principalId: PrincipalId) => DistrictApiClient | Promise<DistrictApiClient>;
  /** The showcase whose classes the courses continue, for each class's teacher. */
  showcase: Showcase;
  /** The class each course is installed into, by package ID, such as `NORTHFIELD_COURSE_CLASSES`. */
  origins: Readonly<Record<string, string>>;
  /**
   * Stop after this many courses have had work done, leaving the rest in `pending`, for a host that
   * must keep each request short. Every course by default.
   */
  maxCourses?: number;
  /** The most units each `teacher.installCourse` call installs; the run calls again until done. All by default. */
  maxUnits?: number;
  /**
   * Whether each teacher publishes the modules the course installed, so the class's students see
   * its pages (never its teacher-only notes) as they see the showcase's own modules. An install
   * leaves them unpublished, as a teacher's would.
   */
  publish?: boolean;
}

type InstallPlan = RouteResponse<"teacher.installCourse">;

/** The frameworks a bundle's activities and course align to, read from its exports and manifests. */
function frameworksOf(bundle: unknown): Set<string> {
  const keys = new Set<string>();
  const parts = bundle as { packages?: { files?: Record<string, string> }[]; exports?: { text?: string }[] };
  const collect = (text: string | undefined) => {
    for (const match of (text ?? "").matchAll(/"frameworkKey"\s*:\s*"([^"]+)"/g)) keys.add(match[1]!);
  };
  for (const exported of parts.exports ?? []) collect(exported.text);
  for (const pkg of parts.packages ?? []) for (const text of Object.values(pkg.files ?? {})) collect(text);
  return keys;
}

const settled = (status: string) => status === "exists" || status === "installed";

/**
 * Imports and installs the sample courses through the district's API. Idempotent: run it again and
 * it imports and installs only what is missing. Returns what it did, per course.
 *
 * @throws DistrictApiError for any call the district refuses (a bundle its pin does not trust, a
 *   course its standards cannot hold), and Error for a course with no class in `origins` or a
 *   framework the district does not offer.
 */
export async function installSampleCourses(options: InstallSampleCoursesOptions): Promise<SampleCoursesSummary> {
  const clients = new Map<string, Promise<DistrictApiClient>>();
  const as = (id: string): Promise<DistrictApiClient> => {
    let client = clients.get(id);
    if (client === undefined) {
      client = Promise.resolve(options.actAs(id as PrincipalId));
      clients.set(id, client);
    }
    return client;
  };
  const classOf = (packageId: string) => {
    const offeringId = options.origins[packageId];
    const course = options.showcase.courses.find((c) => c.offeringId === offeringId);
    if (offeringId === undefined || course === undefined) throw new Error(`${packageId} has no showcase class to install into`);
    return { offeringId, teacherId: course.teacherId };
  };
  for (const { packageId } of options.bundles) classOf(packageId);

  const summary: SampleCoursesSummary = { standardsApproved: 0, courses: [], created: 0, pending: [] };
  const admin = await as(options.adminId);

  // Standards first: an install is refused while any activity aligns to an unapproved framework.
  const frameworks = new Set(options.bundles.flatMap(({ bundle }) => [...frameworksOf(bundle)]));
  const listed = await admin.call("admin.listStandards");
  for (const framework of frameworks) {
    const release = listed.find((s) => s.frameworkKey === framework);
    if (release === undefined) throw new Error(`the district does not offer the ${framework} standards the sample courses align to`);
    if (release.status === "approved") continue;
    await admin.call("admin.approveStandards", { params: { frameworkKey: framework } });
    summary.standardsApproved++;
  }

  const library = await admin.call("admin.listLibraryCourses");
  let worked = 0;
  for (const { packageId, version, bundle } of options.bundles) {
    const { offeringId, teacherId } = classOf(packageId);
    if (options.maxCourses !== undefined && worked >= options.maxCourses) {
      summary.pending.push(packageId);
      continue;
    }
    const result: SampleCourseInstall = { packageId, version, offeringId, imported: false, unitsInstalled: 0, unitsSkipped: 0, pages: 0, teacherNotes: 0, activities: 0, published: 0, done: false };
    if (!library.some((c) => c.packageId === packageId && c.version === version)) {
      await admin.call("admin.importCourseBundle", { body: bundle as never });
      result.imported = true;
    }

    const teacher = await as(teacherId);
    const params = { offeringId };
    const course = { packageId, version };
    const before = await teacher.call("teacher.previewCourseInstall", { params, body: course });
    let plan: InstallPlan = before;
    while (!plan.done) plan = await teacher.call("teacher.installCourse", { params, body: { ...course, ...(options.maxUnits === undefined ? {} : { maxUnits: options.maxUnits }) } });
    for (const unit of plan.units) {
      const was = before.units.find((u) => u.key === unit.key)?.status ?? "new";
      if (unit.status === "exists") result.unitsSkipped++;
      if (unit.status !== "installed" || settled(was)) continue;
      result.unitsInstalled++;
      for (const item of unit.items) {
        if (item.kind === "page") result.pages++;
        else if (item.kind === "teacher-note") result.teacherNotes++;
        else if (item.kind === "activity") result.activities++;
      }
    }
    result.done = plan.done;
    if (options.publish === true) {
      const installed = new Set(plan.units.flatMap((unit) => (unit.status === "installed" && unit.moduleId !== undefined ? [unit.moduleId] : [])));
      for (const module of (await teacher.call("teacher.listModules", { params })).outline.modules) {
        if (!installed.has(module.id) || module.published) continue;
        await teacher.call("teacher.updateModule", { params: { ...params, moduleId: module.id }, body: { published: true } });
        result.published++;
      }
    }
    if (result.imported || result.unitsInstalled > 0 || result.published > 0) worked++;
    summary.courses.push(result);
  }
  summary.created = summary.standardsApproved + summary.courses.reduce((n, c) => n + (c.imported ? 1 : 0) + c.unitsInstalled + c.published, 0);
  return summary;
}
