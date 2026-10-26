// What the district validation suite needs beyond `support.ts`: booting any demo district, picking
// its cast from its own directory, its roster source served by the provider fakes (OneRoster CSV
// built from the fixtures' OneRoster seed, OneRoster REST from `districtSeed`), and its LMS as an LTI
// platform fake. Nothing here names a district: every scenario runs from the district's own data.
import { expect } from "vitest";
import { DistrictDirectorySnapshot, DistrictId, OfferingId, PrincipalId, type Principal } from "@educateos/contracts";
import { districtSeed, oneRosterSeed, type DemoDistrict, type OneRosterSeed } from "@educateos/fixtures";
import { bootHarness } from "@educateos/harness";
import { createDirectoryPrincipalResolver } from "@educateos/identity";
import { oneroster } from "@educateos/integrations";
import {
  createLtiHandler,
  createToolKeySet,
  generateToolKey,
  importToolKey,
  InMemoryPlatformRegistrationStore,
  InMemorySingleUseStore,
  LtiBroker,
  LtiServiceClient,
  PlatformJwksCache,
  toolJwks,
  type DeepLinkSession,
  type LoginState,
  type ResolvedLaunch,
} from "@educateos/lti";
import { canvasFlavour, DEFAULT_ONEROSTER_CLIENT, LtiPlatformFake, OneRosterFake, schoologyFlavour } from "@educateos/provider-fakes";
import { bootDistrictFor, type PilotDistrict, type PilotOverrides } from "./support.ts";

/**
 * Boots one demo district as the harness serves it, from `directory` (its fixture by default),
 * with its guardian relationships recorded in the district's own relationship store (the
 * directory snapshot does not carry them). A district with no roster source owns its directory:
 * its authority is `local`, where the app's default is that OneRoster owns every record.
 */
export async function bootDemo(demo: DemoDistrict, overrides: PilotOverrides = {}, directory: DistrictDirectorySnapshot = demo.directory): Promise<PilotDistrict> {
  const [entry] = await bootHarness([directory]);
  const district = await bootDistrictFor(entry!, { ...(demo.profile.roster === "local" ? { authority: "local" as const } : {}), ...overrides });
  const known = new Set(directory.principals.map((p) => p.id));
  for (const r of demo.guardians) {
    if (!known.has(r.guardianPrincipalId) || !known.has(r.studentPrincipalId)) continue;
    const target = { relationshipId: r.id, guardianPrincipalId: r.guardianPrincipalId, studentPrincipalId: r.studentPrincipalId };
    await district.stores.guardianRelationships.commit(r, { districtId: r.districtId, actor: { principalId: r.created.by }, action: "guardian-relationship.recorded", target, at: r.created.at }, undefined);
  }
  return district;
}

/**
 * The district with `as` signing principals in by their subjects in the directory its stores hold
 * now, rather than in the directory it booted with: after a roster import, the people the import
 * made.
 */
export function signingInFromStore(district: PilotDistrict): PilotDistrict {
  return {
    ...district,
    async as(principalId) {
      const principal = (await directoryOf(district)).principals.find((p) => p.id === principalId);
      if (principal === undefined) throw new Error(`no principal ${principalId} in the district's directory`);
      return district.withToken(await district.entry.identity.issueToken(subjectOfPrincipal(principal)));
    },
  };
}

/** The directory with one enrollment ended, as its source of record leaves it: inactive, not deleted. */
export function withEnrollmentEnded(directory: DistrictDirectorySnapshot, principalId: string, offeringId: string): DistrictDirectorySnapshot {
  return {
    ...directory,
    enrollments: directory.enrollments.map((e) => (e.principalId === principalId && e.offeringId === offeringId ? { ...e, status: "inactive" as const } : e)),
  };
}

/** The OneRoster fake's sourcedId for an enrollment: `<section>:<person>` (see `enrollmentsOf` in the fakes). */
export const fakeEnrollmentId = (offeringId: string, principalId: string) => `${offeringId}:${principalId}`;

/** The people and class a district's scenarios act through, chosen from its own directory. */
export interface Cast {
  admin: Principal;
  /** An active-term class with a lead teacher and at least two active students. */
  offeringId: OfferingId;
  termId: string;
  teacher: Principal;
  student: Principal;
  /** A classmate of `student`. */
  peer: Principal;
  /** A teacher who does not teach `offeringId`, if the district has one. */
  otherTeacher?: Principal;
  /** A guardian and one of their children, if the district has guardians. */
  guardian?: { guardian: Principal; child: Principal };
}

/** The cast of a district: its first class (in directory order) that has a teacher and two students. */
export function castOf(demo: DemoDistrict): Cast {
  const d = demo.directory;
  const byId = (id: string) => d.principals.find((p) => p.id === id)!;
  const active = new Set(d.terms.filter((t) => t.state === "active").map((t) => t.id));
  const members = (offeringId: string, role: string) => d.enrollments.filter((e) => e.offeringId === offeringId && e.role === role && e.status === "active").map((e) => e.principalId);
  const offering = d.offerings.find((o) => active.has(o.termId) && members(o.id, "teacher").length > 0 && members(o.id, "student").length >= 2);
  if (offering === undefined) throw new Error(`${demo.slug} has no active class with a teacher and two students`);
  const [studentId, peerId] = members(offering.id, "student");
  const teacherId = members(offering.id, "teacher")[0]!;
  const teaching = new Set(d.enrollments.filter((e) => e.offeringId === offering.id && e.role !== "student").map((e) => e.principalId));
  const otherTeacherId = d.enrollments.find((e) => e.role === "teacher" && e.status === "active" && !teaching.has(e.principalId))?.principalId;
  const link = demo.guardians.find((g) => g.status === "active");
  return {
    admin: byId(d.roleAssignments.find((r) => r.role === "district-admin")!.principalId),
    offeringId: offering.id,
    termId: offering.termId,
    teacher: byId(teacherId),
    student: byId(studentId!),
    peer: byId(peerId!),
    ...(otherTeacherId === undefined ? {} : { otherTeacher: byId(otherTeacherId) }),
    ...(link === undefined ? {} : { guardian: { guardian: byId(link.guardianPrincipalId), child: byId(link.studentPrincipalId) } }),
  };
}

/** A principal's IdP subject. */
export const subjectOfPrincipal = (p: Principal): string => p.externalIdentities[0]!.subject;

/**
 * A directory as a roster sees it, independent of the IDs an import mints: every active staff
 * member's and student's subject, and each class's active students as a set of subjects. Guardians
 * are left out: a OneRoster import does not roster them.
 */
export function rosterShape(snapshot: DistrictDirectorySnapshot, issuer: string) {
  const subjectOf = new Map(snapshot.principals.map((p) => [p.id, p.externalIdentities.find((i) => i.issuer === issuer)?.subject]));
  const people = snapshot.principals.filter((p) => p.kind !== "guardian" && p.status === "active").map((p) => subjectOf.get(p.id) ?? `(no identity: ${p.id})`).toSorted();
  const classes = snapshot.offerings
    .map((o) => snapshot.enrollments.filter((e) => e.offeringId === o.id && e.role === "student" && e.status === "active").map((e) => subjectOf.get(e.principalId)!).toSorted().join(" "))
    .toSorted();
  return { people, classes };
}

/** What an administrator starts from before a first sync: the district, and its first administrator. */
export function beforeFirstSync(demo: DemoDistrict): DistrictDirectorySnapshot {
  const { directory } = demo;
  const adminId = directory.roleAssignments.find((r) => r.role === "district-admin")!.principalId;
  return DistrictDirectorySnapshot.parse({
    district: directory.district,
    schools: [],
    terms: [],
    courses: [],
    offerings: [],
    principals: directory.principals.filter((p) => p.id === adminId),
    enrollments: [],
    roleAssignments: directory.roleAssignments.filter((r) => r.principalId === adminId && r.scope.level === "district"),
  });
}

// ── OneRoster CSV ──────────────────────────────────────────────────

const csv = (header: string, rows: readonly (readonly string[])[]) =>
  [header, ...rows.map((r) => r.map((v) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)).join(","))].join("\r\n") + "\r\n";

/**
 * A OneRoster 1.2 bulk CSV export of a OneRoster seed, as an SIS writes one: a file per collection,
 * with each user's roles in `roles.csv`. A bulk export omits what is gone, so `tobedeleted`
 * records are left out.
 */
export function oneRosterCsv(seed: OneRosterSeed): Record<string, string> {
  const live = <T extends { status: string }>(records: readonly T[]) => records.filter((r) => r.status === "active");
  const users = live(seed.users);
  return {
    "manifest.csv": csv("propertyName,value", [
      ["manifest.version", "1.0"],
      ["oneroster.version", "1.2"],
      ...["academicSessions", "classes", "courses", "enrollments", "orgs", "roles", "users"].map((file) => [`file.${file}`, "bulk"]),
      ...["categories", "classResources", "courseResources", "demographics", "lineItems", "resources", "results", "userProfiles"].map((file) => [`file.${file}`, "absent"]),
    ]),
    "orgs.csv": csv("sourcedId,status,dateLastModified,name,type,identifier,parentSourcedId", live(seed.orgs).map((o) => [o.sourcedId, "", "", o.name, o.type, o.identifier, o.parent?.sourcedId ?? ""])),
    "academicSessions.csv": csv(
      "sourcedId,status,dateLastModified,title,type,startDate,endDate,parentSourcedId,schoolYear",
      live(seed.academicSessions).map((t) => [t.sourcedId, "", "", t.title, "semester", t.startDate, t.endDate, "", t.schoolYear]),
    ),
    "courses.csv": csv(
      "sourcedId,status,dateLastModified,schoolYearSourcedId,title,courseCode,grades,orgSourcedId,subjects,subjectCodes",
      live(seed.courses).map((c) => [c.sourcedId, "", "", "", c.title, c.courseCode, c.grades.join(","), c.org.sourcedId, c.subjects.join(","), ""]),
    ),
    "classes.csv": csv(
      "sourcedId,status,dateLastModified,title,grades,courseSourcedId,classCode,classType,location,schoolSourcedId,termSourcedIds,subjects,subjectCodes,periods",
      live(seed.classes).map((c) => [c.sourcedId, "", "", c.title, c.grades.join(","), c.course.sourcedId, c.classCode, c.classType, "", c.school.sourcedId, c.terms.map((t) => t.sourcedId).join(","), c.subjects.join(","), "", ""]),
    ),
    "users.csv": csv(
      "sourcedId,status,dateLastModified,enabledUser,username,userIds,givenName,familyName,middleName,identifier,email,sms,phone,agentSourcedIds,grades,password,userMasterIdentifier,resourceSourcedIds,preferredGivenName,preferredMiddleName,preferredFamilyName,primaryOrgSourcedId,pronouns",
      users.map((u) => [u.sourcedId, "", "", String(u.enabledUser), u.username, "", u.givenName, u.familyName, "", "", u.email ?? "", "", "", (u.agents ?? []).map((a) => a.sourcedId).join(","), u.grades.join(","), "", "", "", "", "", "", u.primaryOrg.sourcedId, ""]),
    ),
    "roles.csv": csv(
      "sourcedId,status,dateLastModified,userSourcedId,roleType,role,beginDate,endDate,orgSourcedId,userProfileSourcedId",
      users.flatMap((u) => u.roles.map((r, i) => [`${u.sourcedId}-role-${i}`, "", "", u.sourcedId, r.roleType, r.role, "", "", r.org.sourcedId, ""])),
    ),
    "enrollments.csv": csv(
      "sourcedId,status,dateLastModified,classSourcedId,schoolSourcedId,userSourcedId,role,primary,beginDate,endDate",
      live(seed.enrollments).map((e) => [e.sourcedId, "", "", e.class.sourcedId, e.school.sourcedId, e.user.sourcedId, e.role, e.primary === undefined ? "" : String(e.primary), "", ""]),
    ),
  };
}

/** The district's OneRoster CSV export, after `change` to its seed. */
export function districtCsv(demo: DemoDistrict, change: (seed: OneRosterSeed) => OneRosterSeed = (s) => s): Record<string, string> {
  return oneRosterCsv(change(oneRosterSeed(demo)));
}

/** A seed without one student's enrollment in one class, as after a drop at the SIS. */
export function withoutEnrollment(principalId: string, offeringId: string) {
  return (seed: OneRosterSeed): OneRosterSeed => ({
    ...seed,
    enrollments: seed.enrollments.filter((e) => !(e.user.sourcedId === principalId && e.class.sourcedId === offeringId)),
  });
}

/** The district's directory as its stores hold it now. */
export async function directoryOf(district: PilotDistrict): Promise<DistrictDirectorySnapshot> {
  return (await district.stores.directory.load()).snapshot;
}

/** The ID an import gave a fixture record, found by its OneRoster `sourcedId` (principals carry it in a link). */
function importedId(sources: Record<string, string | { sourcedId: string }>, what: string, sourcedId: string): string {
  const entry = Object.entries(sources).find(([, s]) => (typeof s === "string" ? s : s.sourcedId) === sourcedId);
  if (entry === undefined) throw new Error(`the import made no ${what} of ${sourcedId}`);
  return entry[0];
}

/** The offering an import made of a fixture offering. */
export async function importedOffering(district: PilotDistrict, fixtureOfferingId: string): Promise<OfferingId> {
  return OfferingId.parse(importedId((await district.stores.rosterSources.load()).offerings, "offering", fixtureOfferingId));
}

/** The principal an import made of a fixture principal. */
export async function importedPrincipal(district: PilotDistrict, fixturePrincipalId: string): Promise<PrincipalId> {
  return PrincipalId.parse(importedId((await district.stores.rosterSources.load()).principals, "principal", fixturePrincipalId));
}

// ── OneRoster REST ─────────────────────────────────────────────────

/** The district's OneRoster server as the provider fake, seeded through `districtSeed`, and a sync runner over it. */
export function restRoster(demo: DemoDistrict) {
  const clock = { ms: Date.parse("2026-10-20T15:00:00Z") };
  const fake = new OneRosterFake({ seed: districtSeed(demo), now: () => clock.ms });
  const client = new oneroster.OneRosterRestClient({
    config: { baseUrl: fake.baseUrl, tokenUrl: fake.tokenUrl, scopes: [oneroster.ROSTER_CORE_READONLY_SCOPE], pageSize: 5 },
    credentials: DEFAULT_ONEROSTER_CLIENT,
    fetch: fake.fetch,
    sleep: async () => {},
    clock: () => clock.ms,
  });
  const source = oneroster.restRosterSource(client);
  const config: oneroster.OneRosterImportConfig = { issuer: demo.directory.district.trustedIssuers[0]!, subject: { field: "username" } };
  let runs = 0;
  /** One sync run; `approvedRemoval` is an administrator's approval of a held removal, by its fingerprint. */
  const sync = async (state: oneroster.RosterSyncState, mode: "complete" | "delta", approvedRemoval?: string) => {
    clock.ms += 60_000;
    runs += 1;
    return oneroster.runRosterSync({ state, source, mode, config, runId: `run-${runs}-${mode}`, clock: () => new Date(clock.ms), ...(approvedRemoval === undefined ? {} : { approvedRemoval }) });
  };
  const empty: oneroster.RosterSyncState = {
    roster: {
      snapshot: DistrictDirectorySnapshot.parse({ district: demo.directory.district, schools: [], terms: [], courses: [], offerings: [], principals: [], enrollments: [], roleAssignments: [] }),
      sources: oneroster.EMPTY_SOURCE_MAP,
    },
  };
  return { fake, clock, sync, empty };
}

/**
 * A roster by fixture ID: the active staff and students, and each class's active students. For a
 * directory synced from the fakes, IDs are mapped back through the sync's source map, since the
 * import mints its own and `districtSeed`'s sourcedIds are the fixture's.
 */
export function fixtureShape(snapshot: DistrictDirectorySnapshot, sources?: oneroster.RosterSyncState["roster"]["sources"]) {
  const principal = (id: string) => (sources === undefined ? id : sources.principals[id as never]?.sourcedId ?? `(unmapped ${id})`);
  const offering = (id: string) => (sources === undefined ? id : (sources.offerings[id as never] as string | undefined) ?? `(unmapped ${id})`);
  const people = snapshot.principals.filter((p) => p.kind !== "guardian" && p.status === "active").map((p) => principal(p.id)).toSorted();
  const classes = Object.fromEntries(snapshot.offerings.map((o) => [
    offering(o.id),
    snapshot.enrollments.filter((e) => e.offeringId === o.id && e.role === "student" && e.status === "active").map((e) => principal(e.principalId)).toSorted(),
  ]).toSorted(([a], [b]) => (a! < b! ? -1 : 1)));
  return { people, classes };
}

/** The principal a REST sync made of a fixture principal. */
export function syncedPrincipal(state: oneroster.RosterSyncState, fixturePrincipalId: string): Principal {
  const id = importedId(state.roster.sources.principals, "principal", fixturePrincipalId);
  return state.roster.snapshot.principals.find((p) => p.id === id)!;
}

/** The offering a REST sync made of a fixture offering. */
export function syncedOffering(state: oneroster.RosterSyncState, fixtureOfferingId: string): string {
  return importedId(state.roster.sources.offerings, "offering", fixtureOfferingId);
}

// ── LTI ────────────────────────────────────────────────────────────

/** Where the EducateOS tool is served in these scenarios. */
export const TOOL = "https://tool.educateos.example";

/**
 * The district's LMS as an LTI 1.3 platform fake (Canvas or Schoology, by its profile) seeded
 * through `districtSeed`, with the EducateOS tool registered on it. The district trusts the platform's
 * issuer, every principal is linked to their platform user, and each offering is the platform
 * context of the same section.
 */
export async function ltiWorld(demo: DemoDistrict) {
  const clock = { ms: Date.parse("2026-10-20T15:00:00Z") };
  const now = () => clock.ms;
  const slug = demo.slug;
  const flavour = demo.profile.lms === "schoology-lti"
    ? schoologyFlavour({ issuer: `https://schoology.${slug}.example`, service: `https://lti-service.schoology.${slug}.example` })
    : canvasFlavour({ issuer: `https://canvas.${slug}.example`, sso: `https://sso.canvas.${slug}.example`, domain: `https://${slug}.instructure.example` });
  const toolKeys = createToolKeySet(await importToolKey(await generateToolKey()));
  const fake = await LtiPlatformFake.create({
    flavour,
    seed: districtSeed(demo),
    now,
    tools: [{ name: "EducateOS", initiateLoginUri: `${TOOL}/lti/login`, redirectUris: [`${TOOL}/lti/launch`], jwks: () => toolJwks(toolKeys) }],
  });
  const tool = [...fake.tools.values()][0]!;
  const districtId = DistrictId.parse(demo.directory.district.id);
  const directory = DistrictDirectorySnapshot.parse({
    ...demo.directory,
    district: { ...demo.directory.district, trustedIssuers: [...demo.directory.district.trustedIssuers, fake.issuer] },
    principals: demo.directory.principals.map((p) => ({ ...p, externalIdentities: [...p.externalIdentities, { districtId, issuer: fake.issuer, subject: fake.userOf(p.id).sub }] })),
  });
  const registrations = new InMemoryPlatformRegistrationStore([{
    districtId,
    provider: fake.flavour.name,
    issuer: fake.issuer,
    clientId: tool.clientId,
    deploymentIds: [...tool.deploymentIds],
    authLoginUrl: fake.flavour.authorizationEndpoint,
    authTokenUrl: fake.flavour.tokenEndpoint,
    jwksUrl: fake.flavour.jwksUri,
    offerings: demo.directory.offerings.map((o) => ({ contextId: fake.contextOf(o.id).contextId, offeringId: o.id })),
    activityLinks: [],
  }]);
  const broker = new LtiBroker({
    toolOrigin: TOOL,
    registrations,
    loginStates: new InMemorySingleUseStore<LoginState>(now),
    deepLinkSessions: new InMemorySingleUseStore<DeepLinkSession>(now),
    platformKeys: new PlatformJwksCache({ fetch: fake.fetch, now }),
    toolKeys: () => toolKeys,
    principalResolver: async (id) => (id === districtId ? createDirectoryPrincipalResolver(directory) : undefined),
    now,
  });
  const handler = createLtiHandler({
    broker,
    onResourceLinkLaunch: async (launched) => Response.json({ accepted: launched }),
    onDeepLinkingRequest: async (launched, session) => Response.json({ picker: launched, session }),
    selectActivities: async (_launch, activityIds) => activityIds.map((activityId) => ({ activityId, title: `Activity ${activityId}` })),
  });
  const services = new LtiServiceClient({ fetch: fake.fetch, toolKeys: () => toolKeys, now });

  /** A launch the way a browser makes it: login initiation, the platform's authorization, the form post back. */
  const launch = async (input: Parameters<LtiPlatformFake["initiateLogin"]>[0]) => {
    const initiation = fake.initiateLogin(input);
    const login = (await handler(new Request(initiation.url)))!;
    expect(login.status).toBe(302);
    const authorization = await fake.authorize(login.headers.get("location")!);
    expect(authorization.form?.action).toBe(`${TOOL}/lti/launch`);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    return (await handler(formPost(authorization.form!.action, Object.entries(authorization.form!.fields), cookie)))!;
  };
  /** A launch that must be accepted, and what the tool resolved it to. */
  const accepted = async (input: Parameters<typeof launch>[0]) => {
    const response = await launch(input);
    expect(response.status).toBe(200);
    return ((await response.json()) as { accepted: ResolvedLaunch }).accepted;
  };
  return { clock, now, fake, tool, directory, districtId, registrations, handler, services, launch, accepted };
}

/** A form POST, as a browser submits an auto-posting form. */
export function formPost(url: string, fields: [string, string][], cookie?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (cookie !== undefined) headers.cookie = cookie;
  return new Request(url, { method: "POST", headers, body: new URLSearchParams(fields) });
}
