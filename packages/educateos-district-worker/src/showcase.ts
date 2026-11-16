// The demo showcase (SCHO-326): lets an administrator of a demo district seed the K-12 showcase
// (SCHO-322) inside the district itself and present it by signing in as its personas. Like
// district.ts it imports nothing Workers-only, so it is type-checked on the web-standard surface.
//
// It is for demo districts only. `startDistrict` starts it only when `DISTRICT_CONFIG.demo.showcase`
// and the Worker's committed `DEMO_SHOWCASE` var name the same showcase ({@link showcaseEnabled});
// otherwise every `/api/demo/` path is 404. Every route is a district administrator's, decided by the
// district's policy engine (and so audited) on top of an explicit district-admin check.
//
// - `GET  /api/demo/showcase`          what of the showcase the district holds, per grade band.
// - `GET  /api/demo/showcase/export`   the "before" export: the whole directory, health counts and
//                                      that status, read only, for the operator to keep.
// - `POST /api/demo/showcase/seed`     adds the showcase's directory, guardians and content.
// - `POST /api/demo/showcase/courses`  imports the educateos.io sample courses into the course
//                                      library and installs each into the showcase class it
//                                      continues, one course a request (SCHO-334).
// - `GET  /api/demo/showcase/personas` the personas a presenter can be, and who is each.
// - `POST /api/demo/showcase/personas` links a presenter's Access sign-in to a persona, or frees it.
//
// IDs. The showcase keeps the fixture's IDs (`prn_nf-*`, `off_nf-*`, ...), which are unique
// within any district and which the showcase content is keyed by; only the district ID is mapped,
// to the live district's, on every record. So the demo co-op (`dst_gmacko-coop`) gets the
// Northfield people and classes as its own. Seeding only adds: a record already there under a
// fixture ID is kept as it is (and if it is something else entirely, the run stops before writing
// anything), nothing is changed or deleted, and a rerun adds only what is missing.
//
// Courses. The sample courses' committed signed bundles are bundled into the Worker. The calling
// administrator approves the standards they align to and imports each bundle through the district's
// own course library route, which checks every signature against the deployment's
// `COURSE_LIBRARY_TRUST` (without it, nothing imports); each class's teacher then installs their
// course, which adds the units after the showcase's own modules and publishes them. A request does
// one course and says which are still to do; run it again until none are. A rerun does nothing.
//
// People. The fixture's district administrator is left out, and no showcase record gets a district
// role: the operator who seeds is the administrator. Each persona is created with a placeholder
// sign-in (`educateos-showcase:<id>` under the district's first trusted issuer), which no Access
// sign-in can carry, so nobody is any persona until an administrator links one. A sign-in is
// linked to a persona, moved between personas, or freed; it is never taken from anyone who is not a
// persona, and no persona holding a district role can be linked.
import { z } from "zod";
import { ERROR_STATUS } from "@educateos/academics";
import { createDistrictApiClient, DistrictApiError, type DistrictApiClient } from "@educateos/api-client";
import {
  checkDirectoryIntegrity,
  DistrictDirectorySnapshot,
  EducateOsError,
  externalIdentityKey,
  PrincipalId,
  type Caller,
  type ExternalIdentity,
  type GuardianRelationship,
  type Principal,
} from "@educateos/contracts";
import type { ImportFetch } from "@educateos/content-studio";
import type { DistrictApp, RequestVerifier } from "@educateos/district-app";
import {
  NORTHFIELD,
  NORTHFIELD_COURSE_CLASSES,
  NORTHFIELD_GUARDIANS,
  NORTHFIELD_SHOWCASE,
  SHOWCASE_BANDS,
  SHOWCASE_RESOURCES,
  showcaseResourceHtml,
  type Showcase,
  type ShowcaseBand,
  type ShowcaseResource,
} from "@educateos/fixtures";
import { installSampleCourses, loadSampleCourseBundles, SAMPLE_COURSE_IDS, type SampleCoursesSummary } from "@educateos/harness/sample-courses";
import { schoolDayDue } from "@educateos/harness/school-day";
import { seedShowcase, type ShowcaseSummary } from "@educateos/harness/showcase";
import { createDirectoryPrincipalResolver } from "@educateos/identity";
import { GuardianRelationships } from "@educateos/policy";
import type { DistrictWorkerConfig } from "./config.ts";

/** The prefix of the showcase's administrators' routes. */
export const DEMO_API_PREFIX = "/api/demo/";

/** A showcase a demo district can seed. */
export type ShowcaseName = NonNullable<DistrictWorkerConfig["demo"]>["showcase"];

/**
 * What a showcase is made of: the fixture's directory, its guardian relationships, its content, and
 * the class each sample course continues, by course package ID.
 */
interface ShowcaseContent {
  directory: DistrictDirectorySnapshot;
  guardians: readonly GuardianRelationship[];
  showcase: Showcase;
  courses: Readonly<Record<string, string>>;
}

const CONTENT: Record<ShowcaseName, ShowcaseContent> = {
  northfield: { directory: NORTHFIELD, guardians: NORTHFIELD_GUARDIANS, showcase: NORTHFIELD_SHOWCASE, courses: NORTHFIELD_COURSE_CLASSES },
};

/**
 * The showcase a district may seed: the one `DISTRICT_CONFIG.demo.showcase` names, provided the
 * Worker's `DEMO_SHOWCASE` var names it too. Either alone, or the two disagreeing, is none.
 */
export function showcaseEnabled(demo: DistrictWorkerConfig["demo"], deployed: string | undefined): ShowcaseName | undefined {
  const named = demo?.showcase;
  return named !== undefined && deployed === named ? named : undefined;
}

/** Where the showcase's readings are served from, in the district's own process: a reserved name, never fetched. */
export const SHOWCASE_READINGS_ORIGIN = "https://open-lessons.example";

const readingUrl = (resource: ShowcaseResource): string => `${SHOWCASE_READINGS_ORIGIN}${resource.path}`;

/**
 * The Content Studio's fetch with the showcase's readings answered in-process, so a teacher's import
 * of one needs no host; every other URL goes to `fetch`.
 */
export function withShowcaseReadings(fetch: ImportFetch): ImportFetch {
  return async (url, init) => {
    const reading = SHOWCASE_RESOURCES.find((r) => readingUrl(r) === url);
    if (reading === undefined) return fetch(url, init);
    return new Response(showcaseResourceHtml(reading), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

const PLACEHOLDER_PREFIX = "educateos-showcase:";

/** The subject of a persona's placeholder sign-in. Access subjects are UUIDs, so none can carry it. */
export const placeholderSubject = (principalId: string): string => `${PLACEHOLDER_PREFIX}${principalId}`;

const isPlaceholder = (identity: ExternalIdentity): boolean => identity.subject.startsWith(PLACEHOLDER_PREFIX);

const COLLECTIONS = ["schools", "terms", "courses", "offerings", "principals", "enrollments"] as const;
type Collection = (typeof COLLECTIONS)[number];

/** How many records of each kind a merge adds. */
export type DirectoryAdditions = Record<Collection | "roleAssignments", number>;

/** The fields a record kept under a showcase ID must share with the showcase's, or it is someone else's. */
const SAME: Record<Collection, readonly string[]> = {
  schools: [],
  terms: [],
  courses: [],
  offerings: ["schoolId", "termId", "courseId"],
  principals: ["kind"],
  enrollments: ["offeringId", "principalId", "role"],
};

/**
 * The fixture's directory as records of `live`'s district: every district ID mapped to `live`'s,
 * the district administrator and every district role left out, each person with a placeholder
 * sign-in under `live`'s first trusted issuer, and each role an EducateOS grant.
 */
export function showcaseRecords(fixture: DistrictDirectorySnapshot, live: DistrictDirectorySnapshot): Omit<DistrictDirectorySnapshot, "district"> {
  const districtId = live.district.id;
  const issuer = live.district.trustedIssuers[0];
  if (issuer === undefined) throw new EducateOsError("validation-failed", "The district trusts no sign-in issuer to give the showcase's people.");
  const administrators = new Set(fixture.roleAssignments.filter((r) => r.role === "district-admin").map((r) => r.principalId));
  const here = <T extends { districtId: string }>(record: T): T => ({ ...record, districtId });
  return {
    schools: fixture.schools.map(here),
    terms: fixture.terms.map(here),
    courses: fixture.courses.map(here),
    offerings: fixture.offerings.map(here),
    principals: fixture.principals.filter((p) => !administrators.has(p.id)).map((p) => ({
      ...p,
      districtId,
      externalIdentities: [{ districtId, issuer, subject: placeholderSubject(p.id) }],
    })),
    enrollments: fixture.enrollments.filter((e) => !administrators.has(e.principalId)).map(here),
    roleAssignments: fixture.roleAssignments
      .filter((r) => r.role !== "district-admin" && r.scope.level !== "district" && !administrators.has(r.principalId))
      .map((r) => ({ ...r, scope: { ...r.scope, districtId }, source: "local-grant" as const })),
  };
}

/** A role assignment's identity: who, which role, where. */
const roleKey = (r: DistrictDirectorySnapshot["roleAssignments"][number]): string => JSON.stringify([r.principalId, r.role, r.scope]);

/**
 * `live` with every showcase record it lacks appended, and how many of each that is. Nothing in
 * `live` changes. A record already there under a showcase ID is kept as it is, unless it is plainly
 * something else (another kind of person, an offering of another course), which is a `conflict`:
 * the showcase would attach its classes to someone else's records. The result must pass
 * `checkDirectoryIntegrity`, or nothing is returned.
 */
export function mergeShowcaseDirectory(live: DistrictDirectorySnapshot, records: Omit<DistrictDirectorySnapshot, "district">): { next: DistrictDirectorySnapshot; added: DirectoryAdditions } {
  const next: Record<string, unknown[]> = {};
  const added = {} as DirectoryAdditions;
  for (const name of COLLECTIONS) {
    const existing = new Map<string, Record<string, unknown>>(live[name].map((r) => [r.id, r as Record<string, unknown>]));
    const missing = [];
    for (const record of records[name] as Record<string, unknown>[]) {
      const found = existing.get(record.id as string);
      if (found === undefined) {
        missing.push(record);
        continue;
      }
      if (SAME[name].some((field) => found[field] !== record[field])) {
        throw new EducateOsError("conflict", `The district already has a different record ${String(record.id)} in ${name}; nothing was seeded.`);
      }
    }
    next[name] = [...live[name], ...missing];
    added[name] = missing.length;
  }
  const roles = new Set(live.roleAssignments.map(roleKey));
  const missingRoles = records.roleAssignments.filter((r) => !roles.has(roleKey(r)));
  added.roleAssignments = missingRoles.length;
  const merged = DistrictDirectorySnapshot.parse({ ...live, ...next, roleAssignments: [...live.roleAssignments, ...missingRoles] });
  const issues = checkDirectoryIntegrity(merged);
  if (issues.length > 0) {
    throw new EducateOsError("validation-failed", `The showcase would leave the directory inconsistent at ${issues.slice(0, 3).map((i) => i.path).join(", ")}; nothing was seeded.`);
  }
  return { next: merged, added };
}

/** What linking a sign-in to a persona did. */
export interface PersonaLink {
  /** The persona the sign-in is now linked to, or null when it was freed. */
  personaId: PrincipalId | null;
  /** The persona it was linked to before, if another one. */
  previousPersonaId: PrincipalId | null;
  /** Whether anything changed. */
  changed: boolean;
}

/**
 * `live` with `identity` linked to `personaId` (or, for null, linked to no one), moving it from
 * whichever persona held it. A persona keeps any other presenter's sign-in and loses its
 * placeholder; one left with no sign-in gets its placeholder back. Refused when the sign-in belongs
 * to anyone who is not one of `personas`, when the persona is not one, is not active or holds a
 * district role, and when the result fails `checkDirectoryIntegrity`.
 */
export function linkPersona(
  live: DistrictDirectorySnapshot,
  identity: ExternalIdentity,
  personaId: PrincipalId | null,
  personas: ReadonlySet<string>,
): { next: DistrictDirectorySnapshot; link: PersonaLink } {
  const key = externalIdentityKey(identity);
  const holder = live.principals.find((p) => p.externalIdentities.some((i) => externalIdentityKey(i) === key));
  if (holder !== undefined && !personas.has(holder.id)) {
    throw new EducateOsError("conflict", "That sign-in belongs to one of the district's own people, not a showcase persona; the showcase never takes it.");
  }
  if (personaId !== null) {
    const persona = live.principals.find((p) => p.id === personaId);
    if (persona === undefined || !personas.has(persona.id)) throw new EducateOsError("not-found", "No such showcase persona in this district.");
    if (persona.status !== "active") throw new EducateOsError("conflict", "That persona is not active.");
    if (live.roleAssignments.some((r) => r.principalId === persona.id && r.scope.level === "district")) {
      throw new EducateOsError("forbidden", "A persona with a district role cannot be linked.");
    }
  }
  const previousPersonaId = holder?.id ?? null;
  if (previousPersonaId === personaId) return { next: live, link: { personaId, previousPersonaId, changed: false } };

  const placeholder = (p: Principal): ExternalIdentity => ({ districtId: live.district.id, issuer: live.district.trustedIssuers[0]!, subject: placeholderSubject(p.id) });
  const principals = live.principals.map((p) => {
    if (p.id === holder?.id) {
      const rest = p.externalIdentities.filter((i) => externalIdentityKey(i) !== key);
      return { ...p, externalIdentities: rest.length > 0 ? rest : [placeholder(p)] };
    }
    if (p.id === personaId) return { ...p, externalIdentities: [...p.externalIdentities.filter((i) => !isPlaceholder(i)), identity] };
    return p;
  });
  const next = DistrictDirectorySnapshot.parse({ ...live, principals });
  const issues = checkDirectoryIntegrity(next);
  if (issues.length > 0) throw new EducateOsError("validation-failed", `Linking would leave the directory inconsistent at ${issues.slice(0, 3).map((i) => i.path).join(", ")}.`);
  return { next, link: { personaId, previousPersonaId, changed: true } };
}

/** What the showcase logs: the route's outcome, by counts and IDs. Never a sign-in subject. */
export interface ShowcaseEvent {
  event: "demo.showcase.exported" | "demo.showcase.seeded" | "demo.showcase.courses-installed" | "demo.showcase.persona-linked" | "demo.showcase.failed";
  districtId: string;
  /** The administrator who called. */
  principalId?: string;
  correlationId?: string;
  added?: number;
  created?: number;
  personaId?: string | null;
  /** The sample course a courses request worked on, by package ID. */
  packageId?: string;
  error?: unknown;
}

/** What the showcase is built from. */
export interface DistrictShowcaseOptions {
  /** The running district. */
  app: DistrictApp;
  /** The `/api` sign-in: the same verifier the application uses. */
  verifyRequest: RequestVerifier;
  /** `CF_ACCESS_ISS`: the issuer presenters' sign-ins are linked under. */
  accessIssuer: string | undefined;
  /** The showcase to seed. */
  name: ShowcaseName;
  /** Told what each route did, to log it. */
  onEvent?: (event: ShowcaseEvent) => void;
}

/** The demo showcase's administrators' surface. */
export interface DistrictShowcase {
  /** Serves `/api/demo/*`. */
  serve(request: Request): Promise<Response>;
}

/** The seed route's body. */
export const SeedRequest = z.strictObject({
  /** Only say what the directory would gain; write nothing. */
  dryRun: z.boolean().optional(),
  /** The bands whose classes to build, all by default. The directory and guardians are added either way. */
  bands: z.array(z.enum(SHOWCASE_BANDS as [ShowcaseBand, ...ShowcaseBand[]])).min(1).max(4).optional(),
});

/** The courses route's body. */
export const CoursesRequest = z.strictObject({
  /** Only say what the district holds of each course and which would be worked on; write nothing. */
  dryRun: z.boolean().optional(),
  /** The sample courses to import and install, by package ID; all of them by default. */
  courses: z.array(z.enum([...SAMPLE_COURSE_IDS] as [string, ...string[]])).min(1).max(SAMPLE_COURSE_IDS.length).optional(),
});

/** One sample course, as the district holds it. */
export interface ShowcaseCourseStatus {
  packageId: string;
  /** The showcase class it continues. */
  offeringId: string;
  /** Whether the course library holds it. */
  imported: boolean;
  /** Whether it is fully installed in its class. */
  installed: boolean;
}

/** The persona route's body: an Access subject (`user_uuid`), and the persona to link it to, or null to free it. */
export const PersonaRequest = z.strictObject({
  subject: z.string().min(1).max(255).refine((subject) => !subject.startsWith(PLACEHOLDER_PREFIX), "a placeholder is no one's sign-in"),
  personaId: PrincipalId.nullable(),
});

/** One class of the showcase, as the district holds it. */
export interface ShowcaseOfferingStatus {
  offeringId: string;
  title: string;
  present: boolean;
  assignments: number;
  students: number;
}

/** What of the showcase the district holds. */
export interface ShowcaseStatus {
  showcase: ShowcaseName;
  districtId: string;
  bands: Record<ShowcaseBand, { offerings: ShowcaseOfferingStatus[]; assignments: number }>;
  /** Showcase personas in the directory, and how many a presenter is linked to. */
  personas: { present: number; linked: number };
  /** The sample courses, each imported into the library and installed in its class or not yet. */
  courses: ShowcaseCourseStatus[];
}

/** One persona a presenter can be. */
export interface ShowcasePersona {
  principalId: string;
  displayName: string;
  kind: Principal["kind"];
  /** The bands of the showcase classes they teach, take, or have a child in. */
  bands: ShowcaseBand[];
  /** The showcase classes they teach or take, by title. */
  classes: string[];
  /** The Access subjects linked to them. Empty: nobody is this persona. */
  presenters: string[];
}

/** Starts the showcase for `options.app`. */
export function startDistrictShowcase(options: DistrictShowcaseOptions): DistrictShowcase {
  const { app } = options;
  const content = CONTENT[options.name];
  const districtId = app.districtId;
  const courseOf = new Map(content.showcase.courses.map((c) => [c.offeringId, c]));
  const emit = (event: Omit<ShowcaseEvent, "districtId">) => options.onEvent?.({ ...event, districtId });
  const fixtureTitle = (offeringId: string) => {
    const offering = content.directory.offerings.find((o) => o.id === offeringId);
    return content.directory.courses.find((c) => c.id === offering?.courseId)?.title ?? offeringId;
  };

  const personaIds = (snapshot: DistrictDirectorySnapshot): Set<string> => {
    const showcase = new Set(showcaseRecords(content.directory, snapshot).principals.map((p) => p.id));
    return new Set(snapshot.principals.filter((p) => showcase.has(p.id)).map((p) => p.id));
  };

  /** The caller, if they are a district administrator; the engine's decision is audited under `correlationId`. */
  async function administrator(request: Request, action: "read" | "update", correlationId: string): Promise<Caller> {
    const identity = await options.verifyRequest(request);
    if (identity === undefined) throw new EducateOsError("unauthenticated", "Sign in to manage this district's showcase.");
    const { snapshot } = await app.stores.directory.load();
    const resolved = await createDirectoryPrincipalResolver(snapshot).resolve(identity);
    const subject = { principalId: resolved.principalId, districtId: resolved.districtId };
    const { decision } = await app.engine.decide({
      subject,
      action,
      resource: { kind: "district", scope: { level: "district", districtId }, classification: "district-internal" },
      context: { channel: "http" },
    }, { correlationId });
    const isAdministrator = resolved.kind === "staff"
      && snapshot.roleAssignments.some((r) => r.principalId === resolved.principalId && r.role === "district-admin" && r.scope.level === "district");
    if (decision.effect !== "allow" || !isAdministrator) throw new EducateOsError("forbidden", "Only a district administrator can manage the showcase.");
    return { principal: subject, channel: "http", correlationId };
  }

  /** A client that is `principalId`, served in-process: their own actions, under their own policy. */
  const actAs = (origin: string) => (principalId: PrincipalId): DistrictApiClient => createDistrictApiClient({
    baseUrl: origin,
    fetch: (request) => app.serveAs({ principalId, districtId }, request),
  });

  async function status(): Promise<ShowcaseStatus> {
    const { snapshot } = await app.stores.directory.load();
    const { state } = await app.stores.assessment.load();
    const bands = Object.fromEntries(SHOWCASE_BANDS.map((band) => [band, { offerings: [] as ShowcaseOfferingStatus[], assignments: 0 }])) as ShowcaseStatus["bands"];
    for (const course of content.showcase.courses) {
      const present = snapshot.offerings.some((o) => o.id === course.offeringId);
      const assignments = state.assignments.filter((a) => a.districtId === districtId && a.offeringId === course.offeringId).length;
      const students = snapshot.enrollments.filter((e) => e.offeringId === course.offeringId && e.role === "student" && e.status === "active").length;
      bands[course.band].offerings.push({ offeringId: course.offeringId, title: fixtureTitle(course.offeringId), present, assignments, students });
      bands[course.band].assignments += assignments;
    }
    const personas = personaIds(snapshot);
    const linked = snapshot.principals.filter((p) => personas.has(p.id) && p.externalIdentities.some((i) => !isPlaceholder(i))).length;
    return { showcase: options.name, districtId, bands, personas: { present: personas.size, linked }, courses: await courseStatus(SAMPLE_COURSE_IDS) };
  }

  async function courseStatus(packageIds: readonly string[]): Promise<ShowcaseCourseStatus[]> {
    const library = await app.stores.courseLibrary.listCourses();
    return Promise.all(packageIds.map(async (packageId) => {
      const offeringId = content.courses[packageId]!;
      const installs = await app.stores.courseLibrary.loadInstalls(offeringId);
      return {
        packageId,
        offeringId,
        imported: library.some((c) => c.packageId === packageId),
        installed: installs?.courses.some((c) => c.packageId === packageId && c.completedAt !== undefined) ?? false,
      };
    }));
  }

  /**
   * Imports the sample courses and installs them, as the calling administrator and each class's
   * teacher: the first course with anything to do, and only it, so one request stays short.
   */
  async function installCourses(caller: Caller, origin: string, body: z.infer<typeof CoursesRequest>) {
    const packageIds = body.courses ?? SAMPLE_COURSE_IDS;
    const { snapshot } = await app.stores.directory.load();
    const missing = packageIds.filter((id) => !snapshot.offerings.some((o) => o.id === content.courses[id]));
    if (missing.length > 0) throw new EducateOsError("conflict", `Seed the showcase first: the district has no class for ${missing.join(", ")}.`);
    if (body.dryRun === true) return { dryRun: true as const, courses: await courseStatus(packageIds) };
    const summary: SampleCoursesSummary = await installSampleCourses({
      bundles: await loadSampleCourseBundles(packageIds),
      adminId: caller.principal.principalId,
      actAs: actAs(origin),
      showcase: content.showcase,
      origins: content.courses,
      publish: true,
      maxCourses: 1,
      dueAt: schoolDayDue(new Date(), snapshot.district.timeZone),
    });
    return { dryRun: false as const, ...summary };
  }

  async function listPersonas(): Promise<ShowcasePersona[]> {
    const { snapshot } = await app.stores.directory.load();
    const ids = personaIds(snapshot);
    const enrolled = (id: string) => snapshot.enrollments.filter((e) => e.principalId === id && e.status === "active" && courseOf.has(e.offeringId)).map((e) => courseOf.get(e.offeringId)!);
    return snapshot.principals.filter((p) => ids.has(p.id)).map((p) => {
      const courses = p.kind === "guardian"
        ? content.guardians.filter((g) => g.guardianPrincipalId === p.id).flatMap((g) => enrolled(g.studentPrincipalId))
        : enrolled(p.id);
      return {
        principalId: p.id,
        displayName: p.displayName,
        kind: p.kind,
        bands: SHOWCASE_BANDS.filter((band) => courses.some((c) => c.band === band)),
        classes: [...new Set(courses.map((c) => fixtureTitle(c.offeringId)))],
        presenters: p.externalIdentities.filter((i) => !isPlaceholder(i)).map((i) => i.subject),
      };
    });
  }

  /** Sets up each guardian relationship as an administrator does: recorded, then confirmed. Returns how many it confirmed. */
  async function confirmGuardians(caller: Caller): Promise<number> {
    const relationships = new GuardianRelationships({
      store: app.stores.guardianRelationships,
      directory: app.stores.directory,
      policy: { decide: (request) => app.engine.decide(request, caller.correlationId === undefined ? {} : { correlationId: caller.correlationId }) },
    });
    let confirmed = 0;
    for (const wanted of content.guardians) {
      const open = (await app.stores.guardianRelationships.listForStudent(wanted.studentPrincipalId))
        .find((r) => r.guardianPrincipalId === wanted.guardianPrincipalId && r.status !== "revoked");
      // An active relationship, or one an administrator has suspended, is left as it is.
      if (open !== undefined && open.status !== "pending") continue;
      const id = open?.id ?? (await relationships.record(caller, {
        guardianPrincipalId: wanted.guardianPrincipalId,
        studentPrincipalId: wanted.studentPrincipalId,
        readableKinds: [...wanted.readableKinds],
        consent: wanted.consent,
      })).id;
      await relationships.confirm(caller, id);
      confirmed++;
    }
    return confirmed;
  }

  async function seed(caller: Caller, origin: string, body: z.infer<typeof SeedRequest>) {
    const { snapshot, version } = await app.stores.directory.load();
    const { next, added } = mergeShowcaseDirectory(snapshot, showcaseRecords(content.directory, snapshot));
    const bands = body.bands ?? [...SHOWCASE_BANDS];
    if (body.dryRun === true) return { dryRun: true, directory: added, bands };
    if (Object.values(added).some((n) => n > 0)) await app.stores.directory.commit(next, version);
    const guardiansConfirmed = await confirmGuardians(caller);
    const showcase: ShowcaseSummary = await seedShowcase({
      showcase: { ...content.showcase, courses: content.showcase.courses.filter((c) => bands.includes(c.band)) },
      adminId: caller.principal.principalId,
      actAs: actAs(origin),
      resourceUrl: readingUrl,
      // Due on a school day at 3:30 PM in the district's own time zone, not at the moment of seeding.
      dueAt: schoolDayDue(new Date(), next.district.timeZone),
    });
    return { dryRun: false, directory: added, bands, guardiansConfirmed, showcase };
  }

  async function link(body: z.infer<typeof PersonaRequest>): Promise<PersonaLink> {
    const issuer = options.accessIssuer;
    const { snapshot, version } = await app.stores.directory.load();
    if (issuer === undefined || issuer === "" || !snapshot.district.trustedIssuers.includes(issuer)) {
      throw new EducateOsError("unavailable", "The district does not trust its Access team, so no sign-in can be linked.");
    }
    const { next, link: outcome } = linkPersona(snapshot, { districtId, issuer, subject: body.subject }, body.personaId, personaIds(snapshot));
    if (outcome.changed) await app.stores.directory.commit(next, version);
    return outcome;
  }

  return {
    async serve(request) {
      const correlationId = crypto.randomUUID();
      const url = new URL(request.url);
      const path = url.pathname.slice(DEMO_API_PREFIX.length);
      let caller: Caller | undefined;
      try {
        // Every POST must say it is JSON, which a cross-site form cannot.
        if (request.method === "POST" && !/^application\/json(;|$)/i.test(request.headers.get("content-type") ?? "")) {
          throw new EducateOsError("validation-failed", "Send the request as application/json.");
        }
        const route = `${request.method} ${path}`;
        switch (route) {
          case "GET showcase":
            caller = await administrator(request, "read", correlationId);
            return json(await status(), correlationId);
          case "GET showcase/export": {
            caller = await administrator(request, "read", correlationId);
            const health = await actAs(url.origin)(caller.principal.principalId).call("admin.health");
            const { snapshot } = await app.stores.directory.load();
            const exported = { format: "educateos.showcase-export/v1", exportedAt: new Date().toISOString(), districtId, health, status: await status(), directory: snapshot };
            emit({ event: "demo.showcase.exported", principalId: caller.principal.principalId, correlationId });
            return json(exported, correlationId);
          }
          case "POST showcase/seed": {
            caller = await administrator(request, "update", correlationId);
            const body = parseBody(SeedRequest, await request.json().catch(() => undefined));
            const outcome = await seed(caller, url.origin, body);
            if (!outcome.dryRun) {
              emit({
                event: "demo.showcase.seeded",
                principalId: caller.principal.principalId,
                correlationId,
                added: Object.values(outcome.directory).reduce((a, b) => a + b, 0),
                ...(outcome.showcase === undefined ? {} : { created: outcome.showcase.created }),
              });
            }
            return json(outcome, correlationId);
          }
          case "POST showcase/courses": {
            caller = await administrator(request, "update", correlationId);
            const body = parseBody(CoursesRequest, await request.json().catch(() => undefined));
            const outcome = await installCourses(caller, url.origin, body);
            if (!outcome.dryRun) {
              const worked = outcome.courses.find((c) => c.imported || c.unitsInstalled > 0 || c.published > 0);
              emit({
                event: "demo.showcase.courses-installed",
                principalId: caller.principal.principalId,
                correlationId,
                created: outcome.created,
                ...(worked === undefined ? {} : { packageId: worked.packageId }),
              });
            }
            return json(outcome, correlationId);
          }
          case "GET showcase/personas":
            caller = await administrator(request, "read", correlationId);
            return json(await listPersonas(), correlationId);
          case "POST showcase/personas": {
            caller = await administrator(request, "update", correlationId);
            const body = parseBody(PersonaRequest, await request.json().catch(() => undefined));
            const outcome = await link(body);
            if (outcome.changed) emit({ event: "demo.showcase.persona-linked", principalId: caller.principal.principalId, correlationId, personaId: outcome.personaId });
            return json(outcome, correlationId);
          }
          default:
            await request.body?.cancel();
            throw new EducateOsError("not-found", "No such showcase route.");
        }
      } catch (error) {
        if (!request.bodyUsed) await request.body?.cancel();
        if (error instanceof EducateOsError) return json(error.toBody(), correlationId, ERROR_STATUS[error.code]);
        // A step the district refused while seeding: its code and message, never its body.
        if (error instanceof DistrictApiError) return json({ code: error.code, message: error.message }, correlationId, error.status);
        emit({ event: "demo.showcase.failed", ...(caller === undefined ? {} : { principalId: caller.principal.principalId }), correlationId, error });
        return json({ code: "unavailable", message: "The showcase request could not be completed." }, correlationId, 503);
      }
    },
  };
}

function parseBody<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new EducateOsError("validation-failed", `The request body is invalid at: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))].join(", ")}`.slice(0, 1000));
  }
  return parsed.data;
}

function json(body: unknown, correlationId: string, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-correlation-id": correlationId } });
}
