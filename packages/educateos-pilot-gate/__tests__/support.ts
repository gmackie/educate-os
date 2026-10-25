// Boots both synthetic districts the way the harness serves them (its fake IdPs, the full district
// app over in-memory stores) and gives each scenario typed API clients authenticated with fixture
// tokens. Scenarios reach the district only through these clients unless a criterion says why not.
import { expect } from "vitest";
import type { DistrictDirectorySnapshot, PrincipalId } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { catalogSeedRelease } from "@educateos/catalog";
import type { ImportFetch } from "@educateos/content-studio";
import type { TemplateInput } from "@educateos/curriculum";
import type { RubricDraft } from "@educateos/assessment-ci";
import type { FundingPool } from "@educateos/ai-governance";
import {
  createDistrictApp,
  inMemoryDistrictStores,
  InMemoryPolicyAuditLog,
  type DistrictApp,
  type DistrictAppOptions,
  type DistrictAppStores,
} from "@educateos/district-app";
import { createDistrictApiClient, DistrictApiError, type DistrictApiClient } from "@educateos/api-client";
import { bootHarness, DEMO_PAGES, type HarnessDistrict } from "@educateos/harness";

/** The synthetic model every pilot district funds. */
export const MODEL = { provider: "cloudflare", modelId: "synthetic-pilot-model" } as const;

/**
 * A synthetic web the Content Studio imports from: the harness's demo pages plus any a scenario
 * adds or changes. Every other URL is a 404, and nothing is fetched from the internet.
 */
export class SyntheticWeb {
  readonly #pages = new Map<string, string>(Object.entries(DEMO_PAGES).map(([url, title]) => [url, page(title, "Synthetic lesson text.")]));

  /** Serves `html` at `url`, replacing what was there. */
  set(url: string, html: string): void {
    this.#pages.set(url, html);
  }

  /** Makes `url` answer 404. */
  remove(url: string): void {
    this.#pages.delete(url);
  }

  /** The fetch the district app imports with. */
  readonly fetch: ImportFetch = async (url) => {
    const html = this.#pages.get(url);
    if (html === undefined) return new Response("not found", { status: 404 });
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

/** A minimal HTML page. */
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><title>${title}</title></head><body><p>${body}</p></body></html>`;
}

/** One booted pilot district. */
export interface PilotDistrict {
  /** The harness district: its fake IdP and F02 instance. */
  entry: HarnessDistrict;
  /** The district application. */
  app: DistrictApp;
  /** Its stores. */
  stores: DistrictAppStores;
  /** Its policy decision audit trail. */
  audit: InMemoryPolicyAuditLog;
  /** Its directory as fixtured. */
  directory: DistrictDirectorySnapshot;
  /** Its synthetic web. */
  web: SyntheticWeb;
  /** A typed API client signed in as a principal with a fresh token from the district's IdP. */
  as(principalId: string): Promise<DistrictApiClient>;
  /** A typed API client presenting `token` as is. */
  withToken(token: string): DistrictApiClient;
}

/** What a scenario may change about how a district app is built. */
export type PilotOverrides = Partial<Omit<DistrictAppOptions, "stores" | "verifyRequest">> & { stores?: DistrictAppStores };

/** The district course pool every pilot district funds. */
/** Cents as the nanodollar string the AI ledger uses. */
export const usdNano = (cents: number): string => String(BigInt(cents) * 10_000_000n);

/** A nanodollar string as whole cents (exact for the cent amounts these tests use). */
export const centsOf = (nano: string): number => Number(BigInt(nano) / 10_000_000n);

export function coursePool(snapshot: DistrictDirectorySnapshot, monthlyAllocationCents = 50_000): FundingPool {
  return {
    id: `fpl_${snapshot.district.id.slice("dst_".length)}-courses` as FundingPool["id"],
    name: "Course AI",
    purpose: "course",
    scope: { level: "district", districtId: snapshot.district.id },
    monthlyAllocationUsdNano: usdNano(monthlyAllocationCents),
    allowedModels: [MODEL],
  };
}

/**
 * Builds a district app for a harness district, configured as `bootDistrictApp` in the harness
 * configures it (its IdP's tokens as the only credential, a funded course pool, the synthetic
 * model enabled), with scenario overrides, and approves the ELA and math catalog seeds. The seeds
 * are approved on `app.catalog` directly because the district app has no admin catalog route yet
 * (SCHO-107).
 */
export async function bootDistrictFor(entry: HarnessDistrict, overrides: PilotOverrides = {}): Promise<PilotDistrict> {
  const { directory } = entry.district;
  const web = new SyntheticWeb();
  const audit = new InMemoryPolicyAuditLog();
  const stores = overrides.stores ?? { ...inMemoryDistrictStores(directory), audit };
  const app = await createDistrictApp({
    verifyRequest: async (request) => {
      const header = request.headers.get("authorization") ?? "";
      const verified = header.startsWith("Bearer ") ? await entry.identity.verifyToken(header.slice("Bearer ".length)) : null;
      return verified === null ? undefined : { ...verified, credential: "person" };
    },
    importFetch: web.fetch,
    fundingPools: [coursePool(directory)],
    modelCatalog: [{ ...MODEL, mode: "enabled" }],
    ...overrides,
    stores,
  });
  if (overrides.stores === undefined) await approveCatalogSeeds(app, directory);

  const withToken = (token: string) => createDistrictApiClient({ baseUrl: "http://district.pilot", token, fetch: (request) => app.fetch(request) });
  return {
    entry,
    app,
    stores,
    audit: stores.audit instanceof InMemoryPolicyAuditLog ? stores.audit : audit,
    directory,
    web,
    withToken,
    async as(principalId) {
      return withToken(await entry.identity.issueToken(subjectOf(directory, principalId)));
    },
  };
}

/** Boots both synthetic districts, each its own isolated harness instance and district app. */
export async function bootPilot(overrides: (directory: DistrictDirectorySnapshot) => PilotOverrides = () => ({})) {
  const [northfield, riverbend] = await bootHarness();
  return {
    northfield: await bootDistrictFor(northfield!, overrides(northfield!.district.directory)),
    riverbend: await bootDistrictFor(riverbend!, overrides(riverbend!.district.directory)),
  };
}

/** The IdP subject of a fixture principal. */
export function subjectOf(directory: DistrictDirectorySnapshot, principalId: string): string {
  const principal = directory.principals.find((p) => p.id === principalId);
  if (principal === undefined) throw new Error(`no principal ${principalId}`);
  return principal.externalIdentities[0]!.subject;
}

/** Approves the ELA and math catalog seeds in the district's mirror. */
export async function approveCatalogSeeds(app: DistrictApp, directory: DistrictDirectorySnapshot): Promise<void> {
  const admin = directory.roleAssignments.find((r) => r.role === "district-admin")!.principalId;
  const actor = { by: admin, at: new Date().toISOString() };
  for (const key of ["ccss-ela", "ccss-math"]) {
    const release = await catalogSeedRelease(key);
    await app.catalog.select(key, actor);
    await app.catalog.install(release, actor);
    await app.catalog.approve(key, release.version, actor);
  }
}

/** Expects a call to be refused with this HTTP status and error code. */
export async function expectRefused(call: Promise<unknown>, status: number, code: DistrictApiError["code"]): Promise<DistrictApiError> {
  const error = await call.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DistrictApiError);
  const apiError = error as DistrictApiError;
  expect({ status: apiError.status, code: apiError.code }).toStrictEqual({ status, code });
  return apiError;
}

/** Northfield principals, classes and terms the scenarios use. */
export const NF = {
  admin: "prn_nf-district-admin",
  principal: "prn_nf-principal-high",
  rivera: "prn_nf-teacher-rivera",
  chen: "prn_nf-teacher-chen",
  patel: "prn_nf-teacher-patel",
  morgan: "prn_nf-morgan-lee",
  amara: "prn_nf-student-amara",
  chidi: "prn_nf-student-chidi",
  dmitri: "prn_nf-student-dmitri",
  elena: "prn_nf-student-elena",
  felix: "prn_nf-student-felix",
  eng9: "off_nf-eng9-fall-p3",
  bio: "off_nf-bio-fall-p2",
  bioSpring: "off_nf-bio-spring-p4",
  ushist: "off_nf-ushist-fall-p5",
  math7: "off_nf-math7-fall-p1",
  fall: "trm_nf-2026-fall",
  spring: "trm_nf-2026-spring",
} as const satisfies Record<string, string>;

/** Riverbend principals and classes the scenarios use. */
export const RB = {
  admin: "prn_rb-district-admin",
  haddad: "prn_rb-teacher-haddad",
  morgan: "prn_rb-morgan-lee",
  kai: "prn_rb-student-kai",
  lena: "prn_rb-student-lena",
  ines: "prn_rb-student-ines",
  eng10: "off_rb-eng10-b",
  whist: "off_rb-whist-a",
  bio: "off_rb-bio-a",
} as const satisfies Record<string, string>;

/** A one-criterion essay rubric checked by the built-in `writing.structure` evaluator. */
export const ESSAY_RUBRIC: RubricDraft = {
  rubricId: "rbr_pilot-essay" as RubricDraft["rubricId"],
  version: 1,
  title: "Essay length",
  criteria: [{
    id: "length",
    title: "Length",
    levels: [{ id: "short", label: "Too short", points: 0 }, { id: "enough", label: "Long enough", points: 4 }],
    checks: [{ id: "word-count", evaluatorId: "writing.structure", visibility: "student-visible", config: { minWords: 8 } }],
  }],
};

/** A writing task over one approved resource. */
export function writingTask(resource: { resourceId: string; version: string }, competency: { frameworkKey: string; competencyUri: string }, gradeBand = "9"): TemplateInput {
  return {
    template: "writing-task",
    title: "Should the school day start later?",
    subject: "english-language-arts",
    gradeBand,
    overview: "Write an argument for or against a later start to the school day.",
    resources: [resource],
    codex: [{ kind: "resource", resource, visibility: "students" }],
    alignments: [competency],
    aiHelp: "hints-only",
    due: { kind: "after-install", days: 14 },
    prompt: "Take a position on whether the school day should start later.",
    genre: "argument",
    minimumCitations: 1,
  } as TemplateInput;
}

/** The first competency of an approved catalog seed. */
export async function competencyOf(key: string): Promise<{ frameworkKey: string; competencyUri: string }> {
  const release = await catalogSeedRelease(key);
  return { frameworkKey: key, competencyUri: release.content.nodes![0]!.uri };
}

/**
 * A teacher imports a page, approves it, signs the essay rubric and installs a writing task into
 * one of their classes, all over the API. Returns the release and the assignment.
 */
export async function teacherInstallsEssay(district: PilotDistrict, teacherId: string, offeringId: string, url = "https://open-lessons.example/persuasive-writing") {
  const teacher = await district.as(teacherId);
  const params = { offeringId };
  const item = await teacher.call("teacher.importResource", { params, body: { url } }) as { id: string };
  const release = await teacher.call("teacher.approveResource", { params: { itemId: item.id }, body: {} }) as {
    descriptor: { id: string; release: { version: string; contentDigest: string } };
  };
  const resource = { resourceId: release.descriptor.id, version: release.descriptor.release.version };
  const rubric = await teacher.call("teacher.signRubric", { params, body: { rubric: ESSAY_RUBRIC } });
  const { snapshot } = await district.stores.directory.load();
  const course = snapshot.courses.find((c) => c.id === snapshot.offerings.find((o) => o.id === offeringId)!.courseId)!;
  const draft = await teacher.call("teacher.createActivity", { params, body: { activity: writingTask(resource, await competencyOf("ccss-ela"), course.gradeBand) } });
  await teacher.call("teacher.publishActivity", { params: { definitionId: draft.id } });
  const { installation, assignment } = await teacher.call("teacher.installActivity", {
    params: { definitionId: draft.id },
    body: { offeringId, assignment: { rubric: { rubricId: rubric.rubricId, version: rubric.version } } },
  });
  return { teacher, item, release, resource, rubric, definition: draft, installation, assignment };
}

/** A student writes an essay in their course workspace and submits it, over the API. */
export async function studentSubmitsEssay(district: PilotDistrict, studentId: string, offeringId: string, assignmentId: string, text = "School should start later because teenagers need more sleep to learn well.") {
  const student = await district.as(studentId);
  const workspace = await student.call("student.openCourseWorkspace", { params: { offeringId } });
  const { artifact, head } = await student.call("student.createArtifact", {
    body: { workspaceId: workspace.id, type: "document", title: "My essay", content: { kind: "text", mediaType: "text/markdown", text } },
  });
  const receipt = await student.call("student.submit", { params: { assignmentId }, body: { revisions: [{ artifactId: artifact.id, revisionId: head.id }] } });
  return { student, workspace, artifact, head, receipt };
}

/** Records one settled AI request for a principal's course work, through the gateway governor. */
export async function settleAiRequest(district: PilotDistrict, principalId: string, offeringId: string, cents: number, requestId = `req-${crypto.randomUUID()}`) {
  const decision = await district.app.aiGovernor.beforeRequest({
    requestId,
    principal: { principalId: principalId as PrincipalId, districtId: district.app.districtId },
    workspace: { kind: "course", offeringId },
    model: MODEL,
    estimatedMaxUsdNano: usdNano(cents),
  });
  if (decision.effect !== "allow") return decision;
  await district.app.aiGovernor.afterResponse({
    status: "completed",
    requestId,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    actualUsdNano: usdNano(cents),
  });
  return decision;
}

/** A settable clock for a district app. */
export class PilotClock {
  #now: Date;

  constructor(iso: string) {
    this.#now = new Date(iso);
  }

  /** The current time. */
  readonly now = (): Date => new Date(this.#now);

  /** Moves the clock to `iso`. */
  set(iso: string): void {
    this.#now = new Date(iso);
  }
}

const csv = (header: string, rows: string[][]) => [header, ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n";
const rosterUser = (id: string, username: string, given: string, family: string) =>
  [id, "", "", "true", username, "", given, family, "", "", "", "", "", "", "", "", "", "", "", "", "", "org-nf-high", ""];

/** Who a {@link northfieldRoster} feed enrolls in its one English 9 class. */
export interface RosterClass {
  /** Whether Rivera teaches it. */
  rivera: boolean;
  /** The enrolled students, by IdP username: Amara is `nf-s-2001`, Elena `nf-s-2004`, others from `extraStudents`. */
  students: readonly string[];
  /** Students the feed lists beyond Amara and Elena, as `[username, given, family]`. */
  extraStudents?: readonly (readonly [string, string, string])[];
}

/**
 * A OneRoster 1.2 bulk export for Northfield: one Fall 2026 English 9 class at the high school.
 * Rivera, Amara and Elena are always listed as users (so dropping an enrollment never drops the
 * person); the class's enrollments are what `roster` says.
 */
export function northfieldRoster(roster: RosterClass): Record<string, string> {
  const enrollments: string[][] = [];
  if (roster.rivera) enrollments.push(["e-rivera", "", "", "cls-eng9", "org-nf-high", "u-rivera", "teacher", "true", "", ""]);
  for (const username of roster.students) enrollments.push([`e-${username}`, "", "", "cls-eng9", "org-nf-high", `u-${username}`, "student", "", "", ""]);
  const extra = (roster.extraStudents ?? []).map(([username, given, family]) => [`u-${username}`, username, given, family] as const);
  return {
    "manifest.csv": csv("propertyName,value", [
      ["manifest.version", "1.0"],
      ["oneroster.version", "1.2"],
      ...["academicSessions", "classes", "courses", "enrollments", "orgs", "roles", "users"].map((file) => [`file.${file}`, "bulk"]),
      ...["categories", "classResources", "courseResources", "demographics", "lineItems", "resources", "results", "userProfiles"].map((file) => [`file.${file}`, "absent"]),
    ]),
    "orgs.csv": csv("sourcedId,status,dateLastModified,name,type,identifier,parentSourcedId", [
      ["org-nf-district", "", "", "Northfield Public Schools (synthetic)", "district", "NF", ""],
      ["org-nf-high", "", "", "Northfield High School (roster)", "school", "NF-HS", "org-nf-district"],
    ]),
    "academicSessions.csv": csv("sourcedId,status,dateLastModified,title,type,startDate,endDate,parentSourcedId,schoolYear", [
      ["sem-2026-fall", "", "", "Fall 2026", "semester", "2026-08-31", "2027-01-22", "", "2027"],
    ]),
    "courses.csv": csv("sourcedId,status,dateLastModified,schoolYearSourcedId,title,courseCode,grades,orgSourcedId,subjects,subjectCodes", [
      ["crs-english-9", "", "", "", "English 9", "ENG9", "09", "org-nf-district", "English Language Arts", ""],
    ]),
    "classes.csv": csv("sourcedId,status,dateLastModified,title,grades,courseSourcedId,classCode,classType,location,schoolSourcedId,termSourcedIds,subjects,subjectCodes,periods", [
      ["cls-eng9", "", "", "Period 7", "09", "crs-english-9", "ENG9-7", "scheduled", "Room 207", "org-nf-high", "sem-2026-fall", "", "", "7"],
    ]),
    "users.csv": csv(
      "sourcedId,status,dateLastModified,enabledUser,username,userIds,givenName,familyName,middleName,identifier,email,sms,phone,agentSourcedIds,grades,password,userMasterIdentifier,resourceSourcedIds,preferredGivenName,preferredMiddleName,preferredFamilyName,primaryOrgSourcedId,pronouns",
      [
        rosterUser("u-rivera", "nf-0101", "Sam", "Rivera"),
        rosterUser("u-nf-s-2001", "nf-s-2001", "Amara", "Okafor"),
        rosterUser("u-nf-s-2004", "nf-s-2004", "Elena", "Sato"),
        ...extra.map(([id, username, given, family]) => rosterUser(id, username, given, family)),
      ],
    ),
    "roles.csv": csv("sourcedId,status,dateLastModified,userSourcedId,roleType,role,beginDate,endDate,orgSourcedId,userProfileSourcedId", [
      ["r-rivera", "", "", "u-rivera", "primary", "teacher", "", "", "org-nf-high", ""],
      ["r-nf-s-2001", "", "", "u-nf-s-2001", "primary", "student", "", "", "org-nf-high", ""],
      ["r-nf-s-2004", "", "", "u-nf-s-2004", "primary", "student", "", "", "org-nf-high", ""],
      ...extra.map(([id]) => [`r-${id}`, "", "", id, "primary", "student", "", "", "org-nf-high", ""]),
    ]),
    "enrollments.csv": csv("sourcedId,status,dateLastModified,classSourcedId,schoolSourcedId,userSourcedId,role,primary,beginDate,endDate", enrollments),
  };
}

/**
 * Applies a roster feed as the district administrator and returns the roster's English 9 class
 * (its offering and term), found as Rivera's class that is not the fixture's.
 */
export async function applyNorthfieldRoster(district: PilotDistrict, roster: RosterClass) {
  const admin = await district.as(NF.admin);
  const result = await admin.call("admin.applyRoster", { body: { files: northfieldRoster(roster) } });
  const { snapshot } = await district.stores.directory.load();
  const offering = snapshot.offerings.find((o) => o.sectionName === "Period 7");
  if (offering === undefined) throw new Error(`the roster import did not create its class: ${JSON.stringify(result.preview).slice(0, 2000)}`);
  return { result, offeringId: offering.id, termId: offering.termId };
}

/** Expects a call to be refused as unknown or forbidden: either way the caller learns nothing it may not. */
export async function expectDenied(call: Promise<unknown>): Promise<void> {
  const error = await call.then(() => undefined, (caught: unknown) => caught);
  expect(error, "the call was allowed").toBeInstanceOf(DistrictApiError);
  const { status, code } = error as DistrictApiError;
  expect([[403, "forbidden"], [404, "not-found"]]).toContainEqual([status, code]);
}

/**
 * A principal of the district as a domain service's caller, for the few checks that must call a
 * service the district app does not route.
 */
export function callerOf(district: PilotDistrict, principalId: string, channel: "http" | "agent" = "http") {
  return {
    principal: { principalId: principalId as PrincipalId, districtId: district.app.districtId },
    channel,
  };
}

/** A Northfield offering's policy scope. */
export function offeringScope(offeringId: string) {
  const offering = NORTHFIELD.offerings.find((o) => o.id === offeringId);
  if (offering === undefined) throw new Error(`no Northfield offering ${offeringId}`);
  return { level: "offering" as const, districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id };
}
