// A standalone demo district's seed (SCHO-326): its fixture as the OneRoster 1.2 bulk CSV export its
// roster import reads, or as the authoring steps a local-authority district is built with, the check
// that an import's preview only adds, and the run itself, through the district's own admin routes as
// one district administrator. It imports nothing but the fixtures and the starter pack's listing
// bundle, and reaches the district only through a `DistrictAdminClient`, so the same run serves two
// callers:
//
// - scripts/demo/seed-district.ts, over HTTPS with an administrator's Access cookie, or with the
//   demo operator token;
// - the district Worker's operator route (packages/educateos-district-worker/src/demo-operator.ts),
//   in-process through `DistrictApp.serveAs` as the district's own administrator.

import { DEMO_DISTRICTS, oneRosterSeed, type DemoDistrict, type OneRosterSeed } from "@educateos/fixtures";
import STARTER_PACK from "../../../sites/educateos-io/public/marketplace/listings/middle-school-starter-pack/1.0.0.json" with { type: "json" };

export type { DemoDistrict };

/** The middle school starter pack every standalone demo district gets: the listing bundle educateos.io publishes. */
export const DEMO_STARTER_PACK: unknown = STARTER_PACK;

/** The Access team every demo district trusts, and so the issuer a local person's sign-in uses. */
export const DEMO_ACCESS_ISSUER = "https://gmacko.cloudflareaccess.com";

/** The automation person `--admit-subject` adds. */
export const AUTOMATION = { sourcedId: "eos-demo-automation", givenName: "EducateOS", familyName: "demo automation", displayName: "EducateOS demo automation" } as const;

/** The OneRoster 1.2 CSV header of each file the district reads (`ONEROSTER_HEADERS` in @educateos/integrations). */
const HEADERS = {
  "orgs.csv": ["sourcedId", "status", "dateLastModified", "name", "type", "identifier", "parentSourcedId"],
  "academicSessions.csv": ["sourcedId", "status", "dateLastModified", "title", "type", "startDate", "endDate", "parentSourcedId", "schoolYear"],
  "courses.csv": ["sourcedId", "status", "dateLastModified", "schoolYearSourcedId", "title", "courseCode", "grades", "orgSourcedId", "subjects", "subjectCodes"],
  "classes.csv": ["sourcedId", "status", "dateLastModified", "title", "grades", "courseSourcedId", "classCode", "classType", "location", "schoolSourcedId", "termSourcedIds", "subjects", "subjectCodes", "periods"],
  "users.csv": [
    "sourcedId", "status", "dateLastModified", "enabledUser", "username", "userIds", "givenName", "familyName", "middleName", "identifier", "email", "sms", "phone",
    "agentSourcedIds", "grades", "password", "userMasterIdentifier", "resourceSourcedIds", "preferredGivenName", "preferredMiddleName", "preferredFamilyName", "primaryOrgSourcedId", "pronouns",
  ],
  "roles.csv": ["sourcedId", "status", "dateLastModified", "userSourcedId", "roleType", "role", "beginDate", "endDate", "orgSourcedId", "userProfileSourcedId"],
  "enrollments.csv": ["sourcedId", "status", "dateLastModified", "classSourcedId", "schoolSourcedId", "userSourcedId", "role", "primary", "beginDate", "endDate"],
} as const;

type RosterFile = keyof typeof HEADERS;
type Row<F extends RosterFile> = Partial<Record<(typeof HEADERS)[F][number], string>>;

const cell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const csv = <F extends RosterFile>(file: F, rows: Row<F>[]) =>
  [HEADERS[file].join(","), ...rows.map((row) => HEADERS[file].map((column) => cell((row as Record<string, string | undefined>)[column] ?? "")).join(","))].join("\r\n") + "\r\n";

const list = (values: readonly string[]) => values.join(",");

/** The standalone demo districts: every demo district but Northfield, whose showcase is seeded on its own. */
export const STANDALONE_DEMO_DISTRICTS: readonly DemoDistrict[] = DEMO_DISTRICTS.filter((d) => d.slug !== "northfield");

/** The demo district a host serves (`<slug>.educateos.io`), other than Northfield. */
export function demoFor(origin: string): DemoDistrict {
  const slug = new URL(origin).hostname.split(".")[0];
  const demo = STANDALONE_DEMO_DISTRICTS.find((d) => d.slug === slug);
  if (demo === undefined) throw new Error(`${origin} is not a standalone demo district (${STANDALONE_DEMO_DISTRICTS.map((d) => d.slug).join(", ")})`);
  return demo;
}

/**
 * The standalone demo district whose fixture names `districtId`, as each one's `DISTRICT_CONFIG`
 * keeps its fixture's district ID; none for Northfield or any other district.
 */
export const demoForDistrictId = (districtId: string): DemoDistrict | undefined =>
  STANDALONE_DEMO_DISTRICTS.find((d) => d.directory.district.id === districtId);

/** Whether a demo district builds its own classes (`authority: "local"` in its config) rather than importing a roster. */
export const isLocal = (demo: DemoDistrict): boolean => demo.profile.roster === "local";

/** The principal IDs the live seed already holds: the fixture's district administrators. */
export function seededPrincipals(demo: DemoDistrict): Set<string> {
  return new Set(demo.directory.roleAssignments.filter((r) => r.role === "district-admin" && r.scope.level === "district").map((r) => r.principalId));
}

/**
 * A demo district's fixture as a OneRoster 1.2 bulk CSV export, without its seeded administrators
 * and guardians. With `admitSubject`, also the automation user, as a district administrator role
 * the import records but never grants (the script grants it in EducateOS afterwards).
 */
export function rosterFiles(demo: DemoDistrict, options: { admitSubject?: string } = {}): Record<string, string> {
  const seed: OneRosterSeed = oneRosterSeed(demo);
  const leftOut = seededPrincipals(demo);
  const users = seed.users.filter((u) => !leftOut.has(u.sourcedId) && !u.roles.some((r) => r.role === "guardian"));
  const kept = new Set(users.map((u) => u.sourcedId));
  const districtId = demo.directory.district.id;
  return {
    "manifest.csv": [
      "propertyName,value",
      "manifest.version,1.0",
      "oneroster.version,1.2",
      ...["academicSessions", "classes", "courses", "enrollments", "orgs", "roles", "users"].map((file) => `file.${file},bulk`),
      ...["categories", "classResources", "courseResources", "demographics", "lineItems", "resources", "results", "userProfiles"].map((file) => `file.${file},absent`),
    ].join("\r\n") + "\r\n",
    "orgs.csv": csv("orgs.csv", seed.orgs.map((o) => ({
      sourcedId: o.sourcedId, status: o.status, dateLastModified: o.dateLastModified, name: o.name, type: o.type, identifier: o.identifier, parentSourcedId: o.parent?.sourcedId,
    }))),
    "academicSessions.csv": csv("academicSessions.csv", seed.academicSessions.map((s) => ({
      sourcedId: s.sourcedId, status: s.status, dateLastModified: s.dateLastModified, title: s.title, type: s.type, startDate: s.startDate, endDate: s.endDate, schoolYear: s.schoolYear,
    }))),
    "courses.csv": csv("courses.csv", seed.courses.map((c) => ({
      sourcedId: c.sourcedId, status: c.status, dateLastModified: c.dateLastModified, title: c.title, courseCode: c.courseCode, grades: list(c.grades), orgSourcedId: c.org.sourcedId, subjects: list(c.subjects),
    }))),
    "classes.csv": csv("classes.csv", seed.classes.map((c) => ({
      sourcedId: c.sourcedId, status: c.status, dateLastModified: c.dateLastModified, title: c.title, grades: list(c.grades), courseSourcedId: c.course.sourcedId, classCode: c.classCode,
      classType: c.classType, schoolSourcedId: c.school.sourcedId, termSourcedIds: list(c.terms.map((t) => t.sourcedId)), subjects: list(c.subjects),
    }))),
    "users.csv": csv("users.csv", [
      ...users.map((u) => ({
        sourcedId: u.sourcedId, status: u.status, dateLastModified: u.dateLastModified, enabledUser: String(u.enabledUser), username: u.username,
        userIds: list(u.userIds.map((i) => `{${i.type}:${i.identifier}}`)), givenName: u.givenName, familyName: u.familyName, email: u.email, grades: list(u.grades), primaryOrgSourcedId: u.primaryOrg.sourcedId,
      })),
      ...options.admitSubject === undefined ? [] : [{
        sourcedId: AUTOMATION.sourcedId, status: "active", enabledUser: "true", username: options.admitSubject, givenName: AUTOMATION.givenName, familyName: AUTOMATION.familyName, primaryOrgSourcedId: districtId,
      }],
    ]),
    "roles.csv": csv("roles.csv", [
      ...users.flatMap((u) => u.roles.map((r, i) => ({
        sourcedId: `${u.sourcedId}-role-${i + 1}`, status: "active", dateLastModified: u.dateLastModified, userSourcedId: u.sourcedId, roleType: r.roleType, role: r.role, orgSourcedId: r.org.sourcedId,
      }))),
      ...options.admitSubject === undefined ? [] : [{
        sourcedId: `${AUTOMATION.sourcedId}-role-1`, status: "active", userSourcedId: AUTOMATION.sourcedId, roleType: "primary", role: "districtAdministrator", orgSourcedId: districtId,
      }],
    ]),
    "enrollments.csv": csv("enrollments.csv", seed.enrollments.filter((e) => kept.has(e.user.sourcedId)).map((e) => ({
      sourcedId: e.sourcedId, status: e.status, dateLastModified: e.dateLastModified, classSourcedId: e.class.sourcedId, schoolSourcedId: e.school.sourcedId, userSourcedId: e.user.sourcedId,
      role: e.role, primary: e.primary === undefined ? undefined : String(e.primary),
    }))),
  };
}

/** What a roster preview says (`OneRosterPreview` in @educateos/integrations), as far as this script reads it. */
export interface RosterPreview {
  canApply: boolean;
  issues: { severity: "error" | "warning"; file?: string; row?: number; column?: string; message: string }[];
  integrity: unknown[];
  quarantined: { sourcedId: string; reason: string; message: string }[];
  linked: unknown[];
  changes: Record<string, { added: string[]; updated: string[]; deactivated: string[]; retained: string[] } | { added: unknown[]; removed: unknown[] }>;
}

/** Why a roster preview may not be applied here: it is blocked, or would touch something already there. Empty when it is purely additive. */
export function nonAdditive(preview: RosterPreview): string[] {
  const problems: string[] = [];
  if (!preview.canApply) {
    problems.push("the district would not apply it");
    for (const issue of preview.issues.filter((i) => i.severity === "error")) problems.push(`${issue.file ?? ""}${issue.row === undefined ? "" : `:${issue.row}`} ${issue.column ?? ""} ${issue.message}`.trim());
    if (preview.integrity.length > 0) problems.push(`${preview.integrity.length} integrity issues: ${JSON.stringify(preview.integrity).slice(0, 500)}`);
  }
  if (preview.linked.length > 0) problems.push(`it would link ${preview.linked.length} roster users to people already there`);
  for (const [kind, change] of Object.entries(preview.changes)) {
    if ("removed" in change) {
      if (change.removed.length > 0) problems.push(`it would remove ${change.removed.length} ${kind}`);
    } else {
      if (change.updated.length > 0) problems.push(`it would change ${change.updated.length} existing ${kind}`);
      if (change.deactivated.length > 0) problems.push(`it would deactivate ${change.deactivated.length} ${kind}`);
      if (change.retained.length > 0) problems.push(`${change.retained.length} roster ${kind} are no longer in the export`);
    }
  }
  return problems;
}

/** The counts a preview would add, as one line. */
export function describePreview(preview: RosterPreview): string {
  const counts = Object.entries(preview.changes).map(([kind, change]) => `${change.added.length} ${kind}`).join(", ");
  const warnings = preview.issues.filter((i) => i.severity === "warning").length;
  return `adds ${counts}; ${preview.quarantined.length} quarantined, ${warnings} warnings`;
}

/** One person, class or record of the directory as `admin.authoring` returns it, as far as this script reads it. */
export interface AuthoringDirectory {
  authority: Record<string, string>;
  trustedIssuers: string[];
  schools: { id: string; name: string }[];
  terms: { id: string; name: string }[];
  courses: { id: string; title: string }[];
  offerings: { id: string; schoolId: string; termId: string; courseId: string; sectionName: string }[];
  principals: { id: string; kind: string; displayName: string; districtAdmin: boolean }[];
}

/** One step of a local district's seeding, in dependency order. */
export type LocalStep =
  | { kind: "school"; fixtureId: string; body: { name: string; gradeBands: string[] } }
  | { kind: "term"; fixtureId: string; body: { name: string; startsOn: string; endsOn: string } }
  | { kind: "course"; fixtureId: string; body: { title: string; subject: string; gradeBand: string } }
  | { kind: "offering"; fixtureId: string; school: string; term: string; course: string; sectionName: string }
  | { kind: "principal"; fixtureId: string; body: { kind: "student" | "staff"; displayName: string; email?: string; identity: { issuer: string; subject: string } }; districtAdmin?: boolean }
  | { kind: "enrollment"; fixtureId: string; offering: string; principal: string; role: string };

/**
 * A local district's fixture as authoring steps, without its seeded administrators and guardians.
 * Each person signs in under the Access team as their fixture subject.
 */
export function localSteps(demo: DemoDistrict, options: { admitSubject?: string } = {}): LocalStep[] {
  const d = demo.directory;
  const leftOut = seededPrincipals(demo);
  const people = d.principals.filter((p) => !leftOut.has(p.id) && (p.kind === "student" || p.kind === "staff") && p.status === "active");
  const kept = new Set(people.map((p) => p.id));
  return [
    ...d.schools.map((s): LocalStep => ({ kind: "school", fixtureId: s.id, body: { name: s.name, gradeBands: [...s.gradeBands] } })),
    ...d.terms.map((t): LocalStep => ({ kind: "term", fixtureId: t.id, body: { name: t.name, startsOn: t.startsOn, endsOn: t.endsOn } })),
    ...d.courses.map((c): LocalStep => ({ kind: "course", fixtureId: c.id, body: { title: c.title, subject: c.subject, gradeBand: c.gradeBand } })),
    ...d.offerings.map((o): LocalStep => ({ kind: "offering", fixtureId: o.id, school: o.schoolId, term: o.termId, course: o.courseId, sectionName: o.sectionName })),
    ...people.map((p): LocalStep => ({
      kind: "principal",
      fixtureId: p.id,
      body: {
        kind: p.kind as "student" | "staff",
        displayName: p.displayName,
        ...(p.email === undefined ? {} : { email: p.email }),
        identity: { issuer: DEMO_ACCESS_ISSUER, subject: p.externalIdentities[0]!.subject },
      },
    })),
    ...options.admitSubject === undefined ? [] : [{
      kind: "principal", fixtureId: AUTOMATION.sourcedId, districtAdmin: true,
      body: { kind: "staff", displayName: AUTOMATION.displayName, identity: { issuer: DEMO_ACCESS_ISSUER, subject: options.admitSubject } },
    } satisfies LocalStep],
    ...d.enrollments.filter((e) => e.status === "active" && kept.has(e.principalId)).map((e): LocalStep => ({
      kind: "enrollment", fixtureId: e.id, offering: e.offeringId, principal: e.principalId, role: e.role,
    })),
  ];
}

/** The district's admin routes the run uses, as one administrator. */
export interface DistrictAdminClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/** The district's directory and work counts (`admin.health`). */
export interface DistrictHealth {
  districtId: string;
  directory: { schools: number; terms: number; offerings: number; students: number; staff: number; activeEnrollments: number };
}

/** An installed marketplace pack, as far as the run reads it. */
export interface InstalledPack {
  listingId: string;
  version: string;
}

/** The listing a bundle (`educateos.marketplace.listing/v1`) carries, from its signed payload. */
export function listingOf(bundle: unknown): InstalledPack {
  const payload = (bundle as { listing?: { payload?: { listingId?: unknown; version?: unknown } } }).listing?.payload;
  if (typeof payload?.listingId !== "string" || typeof payload.version !== "string") throw new Error("that is not a marketplace listing bundle");
  return { listingId: payload.listingId, version: payload.version };
}

/** The "before" record: everything the admin read routes say. */
export async function exportDistrict(client: DistrictAdminClient): Promise<Record<string, unknown>> {
  const [health, authoring, offerings, packs] = await Promise.all([
    client.get("/api/admin/health"),
    client.get("/api/admin/authoring"),
    client.get("/api/admin/offerings"),
    client.get("/api/admin/marketplace/packs"),
  ]);
  return { exportedAt: new Date().toISOString(), health, authoring, offerings, packs };
}

/** One line of counts. */
export const describeHealth = (h: DistrictHealth): string =>
  `${h.districtId}: ${h.directory.schools} schools, ${h.directory.terms} terms, ${h.directory.offerings} classes, ${h.directory.staff} staff, ${h.directory.students} students, ${h.directory.activeEnrollments} active enrollments`;

/**
 * Runs `steps` against a local district, creating only what `directory` lacks (matched by name,
 * title, section or sign-in). Returns how many of each it made.
 */
export async function seedLocal(client: DistrictAdminClient, steps: readonly LocalStep[], directory: AuthoringDirectory, log: (line: string) => void, dryRun: boolean): Promise<Record<string, number>> {
  const ids = new Map<string, string>();
  const made: Record<string, number> = {};
  const count = (kind: string) => (made[kind] = (made[kind] ?? 0) + 1);
  const rosters = new Map<string, { principalId: string; role: string }[]>();
  const rosterOf = async (offeringId: string) => {
    if (!rosters.has(offeringId)) {
      const roster = offeringId.startsWith("dry:") ? [] : await client.get<{ enrollment: { principalId: string; role: string; status: string } }[]>(`/api/admin/offerings/${offeringId}/roster`);
      rosters.set(offeringId, roster.map((e) => e.enrollment).filter((e) => e.status === "active"));
    }
    return rosters.get(offeringId)!;
  };
  const create = async <T extends { id: string }>(kind: string, path: string, body: unknown): Promise<string> => {
    count(kind);
    if (dryRun) return `dry:${kind}:${made[kind]}`;
    return (await client.post<T>(path, body)).id;
  };
  const people = new Map(directory.principals.map((p) => [p.displayName, p]));
  for (const step of steps) {
    switch (step.kind) {
      case "school":
        ids.set(step.fixtureId, directory.schools.find((s) => s.name === step.body.name)?.id ?? await create("schools", "/api/admin/schools", step.body));
        break;
      case "term":
        ids.set(step.fixtureId, directory.terms.find((t) => t.name === step.body.name)?.id ?? await create("terms", "/api/admin/terms", step.body));
        break;
      case "course":
        ids.set(step.fixtureId, directory.courses.find((c) => c.title === step.body.title)?.id ?? await create("courses", "/api/admin/courses", step.body));
        break;
      case "offering": {
        const body = { schoolId: ids.get(step.school)!, termId: ids.get(step.term)!, courseId: ids.get(step.course)!, sectionName: step.sectionName };
        const present = directory.offerings.find((o) => o.schoolId === body.schoolId && o.termId === body.termId && o.courseId === body.courseId && o.sectionName === body.sectionName);
        ids.set(step.fixtureId, present?.id ?? await create("offerings", "/api/admin/offerings", body));
        break;
      }
      case "principal": {
        const present = people.get(step.body.displayName);
        const id = present?.id ?? await create("principals", "/api/admin/principals", step.body);
        ids.set(step.fixtureId, id);
        if (step.districtAdmin && !present?.districtAdmin) {
          count("district admins");
          if (!dryRun) await client.post(`/api/admin/principals/${id}/district-admin`, {});
        }
        break;
      }
      case "enrollment": {
        const offeringId = ids.get(step.offering)!;
        const principalId = ids.get(step.principal)!;
        if ((await rosterOf(offeringId)).some((e) => e.principalId === principalId)) break;
        count("enrollments");
        if (!dryRun) await client.post(`/api/admin/offerings/${offeringId}/enrollments`, { principalId, role: step.role });
        break;
      }
    }
  }
  log(`${dryRun ? "would make" : "made"}: ${Object.entries(made).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing new"}`);
  return made;
}

/** What {@link seedDemoDistrict} needs. */
export interface SeedDemoDistrictOptions {
  client: DistrictAdminClient;
  demo: DemoDistrict;
  dryRun: boolean;
  /** An Access subject to add as the automation district administrator. */
  admitSubject?: string;
  /** The listing bundle to install. */
  pack: unknown;
  /** Keeps the "before" export, before anything is changed. */
  saveBefore: (before: Record<string, unknown>) => Promise<void>;
  log: (line: string) => void;
}

/**
 * Export, seed the roster (import or authoring), install the pack, verify. Returns the "before"
 * export and the problems found (none: success). Only additive: a roster import whose preview would
 * change, retain or relink anything already there is refused before anything is written.
 */
export async function seedDemoDistrict(options: SeedDemoDistrictOptions): Promise<{ before: Record<string, unknown>; problems: string[] }> {
  const before = await exportDistrict(options.client);
  await options.saveBefore(before);
  return { before, problems: await seedAfterExport(options, before) };
}

async function seedAfterExport(options: SeedDemoDistrictOptions, before: Record<string, unknown>): Promise<string[]> {
  const { client, demo, dryRun, log } = options;
  log(`before: ${describeHealth(before.health as DistrictHealth)}`);
  const authoring = before.authoring as AuthoringDirectory;
  const admit = options.admitSubject === undefined ? {} : { admitSubject: options.admitSubject };

  if (isLocal(demo)) {
    if (authoring.authority.principal !== "local") return [`${demo.slug} is expected to be local-authority, but the district says principals belong to ${authoring.authority.principal}`];
    await seedLocal(client, localSteps(demo, admit), authoring, log, dryRun);
  } else {
    const files = rosterFiles(demo, admit);
    const preview = await client.post<RosterPreview>("/api/admin/roster/preview", { files });
    log(`roster preview: ${describePreview(preview)}`);
    for (const q of preview.quarantined) log(`  quarantined ${q.sourcedId}: ${q.message}`);
    const problems = nonAdditive(preview);
    const nothingNew = Object.values(preview.changes).every((c) => c.added.length === 0);
    if (problems.length > 0) return problems.map((p) => `roster: ${p}`);
    if (!dryRun && !nothingNew) {
      const applied = await client.post<{ applied: boolean; preview: RosterPreview; grantsRevoked: number }>("/api/admin/roster/apply", { files });
      if (!applied.applied) return [`roster: the district did not apply it: ${nonAdditive(applied.preview).join("; ")}`];
      log(`roster applied: ${describePreview(applied.preview)}`);
    }
    if (options.admitSubject !== undefined && !dryRun) {
      const after = await client.get<AuthoringDirectory>("/api/admin/authoring");
      const automation = after.principals.find((p) => p.displayName === AUTOMATION.displayName);
      if (automation === undefined) return ["the automation person is not in the directory after the import"];
      if (!automation.districtAdmin) await client.post(`/api/admin/principals/${automation.id}/district-admin`, {});
      log(`${AUTOMATION.displayName} (${automation.id}) is a district administrator`);
    }
  }

  const { listingId, version } = listingOf(options.pack);
  const packs = before.packs as InstalledPack[];
  if (packs.some((p) => p.listingId === listingId && p.version === version)) log(`${listingId} ${version} is already installed`);
  else if (dryRun) log(`would install ${listingId} ${version}`);
  else {
    const pack = await client.post<InstalledPack>("/api/admin/marketplace/packs", options.pack);
    log(`installed ${pack.listingId} ${pack.version}`);
  }
  return dryRun ? [] : verify(client, demo, listingId, log);
}

/** Checks the fixture's classes are all listed with students, and the pack is installed. */
export async function verify(client: DistrictAdminClient, demo: DemoDistrict, listingId: string, log: (line: string) => void): Promise<string[]> {
  const [health, offerings, packs] = await Promise.all([
    client.get<DistrictHealth>("/api/admin/health"),
    client.get<{ offering: { id: string; sectionName: string }; course: { title: string }; students: number }[]>("/api/admin/offerings"),
    client.get<InstalledPack[]>("/api/admin/marketplace/packs"),
  ]);
  log(`after: ${describeHealth(health)}; packs: ${packs.map((p) => `${p.listingId} ${p.version}`).join(", ") || "none"}`);
  const problems: string[] = [];
  const courses = new Map(demo.directory.courses.map((c) => [c.id, c.title]));
  for (const o of demo.directory.offerings) {
    const title = courses.get(o.courseId)!;
    const listed = offerings.find((row) => row.course.title === title && row.offering.sectionName === o.sectionName);
    if (listed === undefined) problems.push(`${title} · ${o.sectionName} is not in the admin console's classes`);
    else if (listed.students === 0 && demo.directory.enrollments.some((e) => e.offeringId === o.id && e.role === "student" && e.status === "active")) problems.push(`${title} · ${o.sectionName} has no students`);
  }
  if (!packs.some((p) => p.listingId === listingId)) problems.push(`${listingId} is not installed`);
  for (const problem of problems) log(`problem: ${problem}`);
  return problems;
}

