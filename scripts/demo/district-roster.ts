// The pure half of seed-district.ts (SCHO-326): a standalone demo district's fixture as the OneRoster
// 1.2 bulk CSV export its roster import reads, or as the authoring steps a local-authority district
// is built with, and the check that an import's preview only adds. It imports nothing but the
// fixtures, so the district Worker's suite can run it against the real importer
// (packages/educateos-district-worker/__tests__/demo-district-rosters.test.ts).

import { DEMO_DISTRICTS, oneRosterSeed, type DemoDistrict, type OneRosterSeed } from "../../packages/educateos-fixtures/src/index.ts";

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

/** The demo district a host serves (`<slug>.educateos.io`), other than Northfield. */
export function demoFor(origin: string): DemoDistrict {
  const slug = new URL(origin).hostname.split(".")[0];
  const demo = DEMO_DISTRICTS.find((d) => d.slug === slug);
  if (demo === undefined || demo.slug === "northfield") throw new Error(`${origin} is not a standalone demo district (${DEMO_DISTRICTS.filter((d) => d.slug !== "northfield").map((d) => d.slug).join(", ")})`);
  return demo;
}

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
