import { expect } from "vitest";
import { EducateOsErrorBody, type DistrictDirectorySnapshot, type PrincipalId, type VerifiedIdentity } from "@educateos/contracts";
import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import { usdNanoFromCents } from "@educateos/ai-governance";
import { catalogSeedRelease } from "@educateos/catalog";
import type { ImportFetch } from "@educateos/content-studio";
import type { TemplateInput } from "@educateos/curriculum";
import type { RubricDraft } from "@educateos/assessment-ci";
import {
  CORRELATION_HEADER,
  createDistrictApp,
  inMemoryDistrictStores,
  InMemoryPolicyAuditLog,
  ROUTES,
  routePath,
  successStatus,
  type DistrictApp,
  type DistrictAppOptions,
  type RouteInput,
  type RouteName,
  type RouteResponse,
} from "../src/index.ts";

/** A stand-in IdP: opaque random tokens, each bound to one subject of one issuer. */
export class TestIdentityProvider {
  readonly issuer: string;
  readonly #tokens = new Map<string, string>();

  constructor(issuer: string) {
    this.issuer = issuer;
  }

  /** A token proving `subject`. */
  issue(subject: string): string {
    const token = crypto.randomUUID();
    this.#tokens.set(token, subject);
    return token;
  }

  /** The verifier the app is given: only this IdP's tokens verify. */
  readonly verify = async (request: Request): Promise<VerifiedIdentity | undefined> => {
    const header = request.headers.get("authorization") ?? "";
    const subject = header.startsWith("Bearer ") ? this.#tokens.get(header.slice("Bearer ".length)) : undefined;
    return subject === undefined ? undefined : { issuer: this.issuer, subject, credential: "person" };
  };
}

/** Synthetic pages the Content Studio imports, by URL. */
export const PAGES = {
  essay: "https://open-lessons.example/persuasive-writing",
  lab: "https://open-lessons.example/osmosis-lab",
};

/** A synthetic web: each known URL serves a small HTML page; every other URL is a 404. */
export const importFetch: ImportFetch = async (url) => {
  const titles: Record<string, string> = { [PAGES.essay]: "Persuasive Writing Models", [PAGES.lab]: "Osmosis in Potato Cells" };
  const title = titles[url];
  if (title === undefined) return new Response("not found", { status: 404 });
  return new Response(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><p>Synthetic text.</p></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

/** The result of one API call: the status, the parsed JSON body and the correlation ID. */
export interface CallResult<T> {
  status: number;
  body: T;
  correlationId: string;
}

/** A booted district with its IdP and a typed caller that checks every response against its schema. */
export interface TestDistrict {
  app: DistrictApp;
  idp: TestIdentityProvider;
  audit: InMemoryPolicyAuditLog;
  directory: DistrictDirectorySnapshot;
  /** A token for the principal with this ID. */
  tokenFor(principalId: string): string;
  /** Calls a route as `token` and expects success, returning the schema-checked body. */
  ok<N extends RouteName>(token: string, name: N, input?: RouteInput<N>): Promise<RouteResponse<N>>;
  /** Calls a route as `token` and returns whatever came back; error bodies are schema-checked too. */
  call<N extends RouteName>(token: string | undefined, name: N, input?: RouteInput<N>, extraHeaders?: Record<string, string>): Promise<CallResult<unknown>>;
}

/**
 * Boots a district application over in-memory stores, with the ELA and math catalog seeds approved
 * unless `standards` names others (`[]` for a district that has approved none, SCHO-220).
 */
export async function bootDistrict(
  directory: DistrictDirectorySnapshot = NORTHFIELD,
  { standards = ["ccss-ela", "ccss-math"], ...options }: Partial<Pick<DistrictAppOptions, "projects" | "fundingPools" | "modelCatalog" | "aiMonthlyDistrictCapUsdNano" | "cloudflareAccount" | "now" | "authority"
    // Scheduled roster sync (SCHO-203)
    | "rosterSource" | "rosterServicePrincipalId"
    // Communication (SCHO-189)
    | "mail" | "appUrl"
    // Discussions (SCHO-190)
    | "discussionScreening" | "unscreenedStudentPosts"
    // Devices (SCHO-261)
    | "deviceTokenSecret"
    // Operations (SCHO-263)
    | "release" | "opsAnalytics">> & { standards?: readonly string[] } = {},
): Promise<TestDistrict> {
  const idp = new TestIdentityProvider(directory.district.trustedIssuers[0]!);
  const stores = inMemoryDistrictStores(directory);
  const audit = new InMemoryPolicyAuditLog();
  const app = await createDistrictApp({
    stores: { ...stores, audit },
    verifyRequest: idp.verify,
    importFetch,
    fundingPools: [{
      id: "fpl_courses" as never,
      name: "Course AI",
      purpose: "course",
      scope: { level: "district", districtId: directory.district.id },
      monthlyAllocationUsdNano: usdNanoFromCents(10_000),
      allowedModels: [{ provider: "cloudflare", modelId: "synthetic-model" }],
    }],
    modelCatalog: [{ provider: "cloudflare", modelId: "synthetic-model", mode: "enabled" }],
    // Synthetic districts publish unscreened posts unless a test asks for the production default.
    unscreenedStudentPosts: "publish",
    ...options,
  });
  const admin = directory.roleAssignments.find((r) => r.role === "district-admin")!.principalId;
  const actor = { by: admin, at: new Date().toISOString() };
  for (const key of standards) {
    const release = await catalogSeedRelease(key);
    await app.catalog.select(key, actor);
    await app.catalog.install(release, actor);
    await app.catalog.approve(key, release.version, actor);
  }

  const tokenFor = (principalId: string) => {
    const principal = directory.principals.find((p) => p.id === principalId);
    if (principal === undefined) throw new Error(`no principal ${principalId}`);
    return idp.issue(principal.externalIdentities[0]!.subject);
  };

  const call = async <N extends RouteName>(token: string | undefined, name: N, input: RouteInput<N> = {} as RouteInput<N>, extraHeaders: Record<string, string> = {}) => {
    const spec = ROUTES[name];
    const parts = input as { params?: Record<string, string>; query?: Record<string, string>; body?: unknown };
    const url = new URL(routePath(spec.path, parts.params), "https://district.example");
    for (const [key, value] of Object.entries(parts.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    Object.assign(headers, extraHeaders);
    const response = await app.fetch(new Request(url, {
      method: spec.method,
      headers,
      ...(spec.method === "POST" ? { body: JSON.stringify(parts.body ?? {}) } : {}),
    }));
    const body: unknown = await response.json();
    const correlationId = response.headers.get(CORRELATION_HEADER) ?? "";
    if (response.ok) {
      expect(response.status).toBe(successStatus(spec));
      spec.response.parse(body);
    } else {
      expect(EducateOsErrorBody.parse(body).correlationId).toBe(correlationId);
    }
    return { status: response.status, body, correlationId };
  };

  const ok = async <N extends RouteName>(token: string, name: N, input?: RouteInput<N>): Promise<RouteResponse<N>> => {
    const result = await call(token, name, input);
    if (result.status >= 400) throw new Error(`${name} failed with ${result.status}: ${JSON.stringify(result.body)}`);
    return ROUTES[name].response.parse(result.body) as RouteResponse<N>;
  };

  return { app, idp, audit, directory, tokenFor, ok, call };
}

/** Expects a call to have failed with `status` and error `code`. */
export function expectError(result: CallResult<unknown>, status: number, code: EducateOsErrorBody["code"]): void {
  expect({ status: result.status, code: (result.body as EducateOsErrorBody).code }).toStrictEqual({ status, code });
}

/** The first competency of an approved catalog seed release. */
export async function competencyOf(key: string): Promise<{ frameworkKey: string; competencyUri: string }> {
  const release = await catalogSeedRelease(key);
  return { frameworkKey: key, competencyUri: release.content.nodes![0]!.uri };
}

/** Northfield principals and offerings the tests use. */
export const NF = {
  admin: "prn_nf-district-admin",
  rivera: "prn_nf-teacher-rivera",
  chen: "prn_nf-teacher-chen",
  morgan: "prn_nf-morgan-lee",
  amara: "prn_nf-student-amara",
  elena: "prn_nf-student-elena",
  dmitri: "prn_nf-student-dmitri",
  eng9: "off_nf-eng9-fall-p3",
  bio: "off_nf-bio-fall-p2",
  bioSpring: "off_nf-bio-spring-p4",
  fall: "trm_nf-2026-fall",
  spring: "trm_nf-2026-spring",
} as const satisfies Record<string, string>;

/** A Riverbend principal and offering. */
export const RB = { teacher: "prn_rb-teacher-haddad", student: "prn_rb-student-kai", eng10: "off_rb-eng10-b" } as const;

export { NORTHFIELD, RIVERBEND };

/** An English 9 argumentative essay activity using one resource release. */
export function essayActivity(resource: { resourceId: string; version: string }, competency: { frameworkKey: string; competencyUri: string }): TemplateInput {
  return {
    template: "writing-task",
    title: "Should the school day start later?",
    subject: "english-language-arts",
    gradeBand: "9",
    overview: "Write an argument for or against a later start to the school day.",
    resources: [resource],
    codex: [{ kind: "resource", resource, visibility: "students" }],
    alignments: [competency],
    aiHelp: "hints-only",
    due: { kind: "after-install", days: 14 },
    prompt: "Take a position on whether the school day should start later.",
    genre: "argument",
    minimumCitations: 2,
  } as TemplateInput;
}

/** A two-criterion essay rubric checked by the built-in `writing.structure` and `content.required` evaluators. */
export const ESSAY_RUBRIC: RubricDraft = {
  rubricId: "rbr_essay-basics" as RubricDraft["rubricId"],
  version: 1,
  title: "Essay basics",
  criteria: [
    {
      id: "length",
      title: "Length",
      levels: [{ id: "short", label: "Too short", points: 0 }, { id: "enough", label: "Long enough", points: 4 }],
      checks: [{ id: "word-count", evaluatorId: "writing.structure", visibility: "student-visible", config: { minWords: 10 } }],
    },
    {
      id: "evidence",
      title: "Evidence",
      levels: [{ id: "none", label: "No evidence", points: 0 }, { id: "cited", label: "Cites evidence", points: 4 }],
      checks: [{ id: "cites", evaluatorId: "content.required", visibility: "student-visible", config: { items: [{ label: "A citation", anyOf: ["[1]"] }] } }],
    },
  ],
};

/** Imports, approves, signs a rubric, creates, publishes and installs an essay in English 9 as Rivera, with a rubric. */
export async function teacherSetsUpEssay(district: TestDistrict, teacher: string = district.tokenFor(NF.rivera)) {
  const item = await district.ok(teacher, "teacher.importResource", { params: { offeringId: NF.eng9 }, body: { url: PAGES.essay } }) as { id: string };
  const release = await district.ok(teacher, "teacher.approveResource", { params: { itemId: item.id }, body: { alignments: [] } }) as {
    descriptor: { id: string; release: { version: string } };
  };
  const resource = { resourceId: release.descriptor.id, version: release.descriptor.release.version };
  const rubric = await district.ok(teacher, "teacher.signRubric", { params: { offeringId: NF.eng9 }, body: { rubric: ESSAY_RUBRIC } });
  const draft = await district.ok(teacher, "teacher.createActivity", {
    params: { offeringId: NF.eng9 },
    body: { activity: essayActivity(resource, await competencyOf("ccss-ela")) },
  });
  await district.ok(teacher, "teacher.publishActivity", { params: { definitionId: draft.id } });
  const installed = await district.ok(teacher, "teacher.installActivity", {
    params: { definitionId: draft.id },
    body: { offeringId: NF.eng9, assignment: { rubric: { rubricId: rubric.rubricId, version: rubric.version } } },
  });
  return { item, release, resource, rubric, draft, ...installed };
}

/** A student opens their English 9 workspace, writes an essay, saves a second draft and submits it. */
export async function studentSubmitsEssay(district: TestDistrict, assignmentId: string, student: string = district.tokenFor(NF.amara)) {
  const workspace = await district.ok(student, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
  const created = await district.ok(student, "student.createArtifact", {
    body: {
      workspaceId: workspace.id,
      type: "document",
      title: "Later start essay",
      content: { kind: "text", mediaType: "text/markdown", text: "School should start later. [1]" },
    },
  });
  const saved = await district.ok(student, "student.saveRevision", {
    params: { artifactId: created.artifact.id },
    body: { content: { kind: "text", mediaType: "text/markdown", text: "School should start later because sleep matters [1]. Studies agree [2]." } },
  });
  const receipt = await district.ok(student, "student.submit", {
    params: { assignmentId },
    body: { revisions: [{ artifactId: saved.artifact.id, revisionId: saved.head.id }] },
  });
  return { workspace, artifact: saved.artifact, head: saved.head, receipt };
}

const csv = (header: string, rows: string[][]) => [header, ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n";
const user = (id: string, username: string, given: string, family: string) =>
  [id, "", "", "true", username, "", given, family, "", "", "", "", "", "", "", "", "", "", "", "", "", "org-nf-high", ""];

/** A minimal OneRoster export for Northfield: one class of English 9, Rivera, Amara and a new student. */
export function rosterExport(): Record<string, string> {
  return {
    "manifest.csv": csv("propertyName,value", [
      ["manifest.version", "1.0"],
      ["oneroster.version", "1.2"],
      ...["academicSessions", "classes", "courses", "enrollments", "orgs", "roles", "users"].map((file) => [`file.${file}`, "bulk"]),
      ...["categories", "classResources", "courseResources", "demographics", "lineItems", "resources", "results", "userProfiles"].map((file) => [`file.${file}`, "absent"]),
    ]),
    "orgs.csv": csv("sourcedId,status,dateLastModified,name,type,identifier,parentSourcedId", [
      ["org-nf-district", "", "", "Northfield Public Schools (synthetic)", "district", "NF", ""],
      ["org-nf-high", "", "", "Northfield High School", "school", "NF-HS", "org-nf-district"],
    ]),
    "academicSessions.csv": csv("sourcedId,status,dateLastModified,title,type,startDate,endDate,parentSourcedId,schoolYear", [
      ["sem-2026-fall", "", "", "Fall 2026", "semester", "2026-08-31", "2027-01-22", "", "2027"],
    ]),
    "courses.csv": csv("sourcedId,status,dateLastModified,schoolYearSourcedId,title,courseCode,grades,orgSourcedId,subjects,subjectCodes", [
      ["crs-english-9", "", "", "", "English 9", "ENG9", "09", "org-nf-district", "English Language Arts", ""],
    ]),
    "classes.csv": csv("sourcedId,status,dateLastModified,title,grades,courseSourcedId,classCode,classType,location,schoolSourcedId,termSourcedIds,subjects,subjectCodes,periods", [
      ["cls-eng9-fall-p3", "", "", "Period 3", "09", "crs-english-9", "ENG9-3", "scheduled", "Room 201", "org-nf-high", "sem-2026-fall", "", "", "3"],
    ]),
    "users.csv": csv(
      "sourcedId,status,dateLastModified,enabledUser,username,userIds,givenName,familyName,middleName,identifier,email,sms,phone,agentSourcedIds,grades,password,userMasterIdentifier,resourceSourcedIds,preferredGivenName,preferredMiddleName,preferredFamilyName,primaryOrgSourcedId,pronouns",
      [user("u-rivera", "nf-0101", "Sam", "Rivera"), user("u-amara", "nf-s-2001", "Amara", "Okafor"), user("u-new", "nf-s-2099", "Robin", "Newcomer")],
    ),
    "roles.csv": csv("sourcedId,status,dateLastModified,userSourcedId,roleType,role,beginDate,endDate,orgSourcedId,userProfileSourcedId", [
      ["r-rivera", "", "", "u-rivera", "primary", "teacher", "", "", "org-nf-high", ""],
      ["r-amara", "", "", "u-amara", "primary", "student", "", "", "org-nf-high", ""],
      ["r-new", "", "", "u-new", "primary", "student", "", "", "org-nf-high", ""],
    ]),
    "enrollments.csv": csv("sourcedId,status,dateLastModified,classSourcedId,schoolSourcedId,userSourcedId,role,primary,beginDate,endDate", [
      ["e-1", "", "", "cls-eng9-fall-p3", "org-nf-high", "u-rivera", "teacher", "true", "", ""],
      ["e-2", "", "", "cls-eng9-fall-p3", "org-nf-high", "u-amara", "student", "", "", ""],
      ["e-3", "", "", "cls-eng9-fall-p3", "org-nf-high", "u-new", "student", "", "", ""],
    ]),
  };
}

/** A Northfield configuration document. */
export function northfieldConfig(): Record<string, unknown> {
  return {
    apiVersion: "educateos.io/v1alpha1",
    district: "dst_northfield",
    profile: "us-k12-conservative",
    identity: { provider: "district-sso" },
    rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
    modules: { "core-learning": "enabled", "learning-registry": "enabled", "content-studio": "enabled" },
    rollout: { target: "selected-course-offerings", offerings: [NF.eng9, NF.bio], requiresAdminActivation: true },
    policies: { ai: { spending: "capped", promptsInGatewayLogs: false } },
  };
}

/** Records one settled AI request for a student's course work, through the gateway governor. */
export async function recordAiRequest(district: TestDistrict, principalId: string, offeringId: string): Promise<void> {
  const requestId = `req-${crypto.randomUUID()}`;
  const decision = await district.app.aiGovernor.beforeRequest({
    requestId,
    principal: { principalId: principalId as PrincipalId, districtId: district.app.districtId },
    workspace: { kind: "course", offeringId },
    model: { provider: "cloudflare", modelId: "synthetic-model" },
    estimatedMaxUsdNano: usdNanoFromCents(5),
  });
  expect(decision.effect).toBe("allow");
  await district.app.aiGovernor.afterResponse({
    status: "completed",
    requestId,
    usage: { inputTokens: 120, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
    actualUsdNano: usdNanoFromCents(2),
  });
}
