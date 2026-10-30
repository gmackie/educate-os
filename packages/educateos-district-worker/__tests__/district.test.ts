// The district Worker in workerd, over a real SQLite Durable Object: what the district writes through
// its `/api` surface and its school tools survives a restart of its object, requests are accepted
// only with a valid Access assertion, and the guard and gatekeeper entrypoints answer over real
// service bindings.

import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { ROUTES, routePath, type RouteInput, type RouteName, type RouteResponse } from "@educateos/district-app/routes";
import { ACCESS_AUDIENCE, ACCESS_ISSUER, WORKSHOP_ACCESS_AUDIENCE } from "./fixtures.ts";

const NF = {
  admin: "prn_nf-district-admin",
  rivera: "prn_nf-teacher-rivera",
  amara: "prn_nf-student-amara",
  eng9: "off_nf-eng9-fall-p3",
} as const;

/** The district's object: one per district, named by its ID, as the Worker names it. */
const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);

/** An Access assertion for `subject`, signed with this run's key; `claims` override the defaults. */
async function assertion(subject: string, claims: Record<string, unknown> = {}): Promise<string> {
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

/** An assertion for a Northfield principal, by its IdP subject. */
async function signIn(principalId: string): Promise<string> {
  const principal = NORTHFIELD.principals.find((p) => p.id === principalId)!;
  return assertion(principal.externalIdentities[0]!.subject);
}

function request<N extends RouteName>(token: string | undefined, name: N, input: RouteInput<N> = {} as RouteInput<N>): Request {
  const spec = ROUTES[name];
  const parts = input as { params?: Record<string, string>; body?: unknown };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["cf-access-jwt-assertion"] = token;
  return new Request(new URL(routePath(spec.path, parts.params), "https://district.example"), {
    method: spec.method,
    headers,
    ...(spec.method === "POST" ? { body: JSON.stringify(parts.body ?? {}) } : {}),
  });
}

/**
 * Fetches through the Worker and reads the whole body before returning, so no response is left
 * open in the district's object: an unread body keeps its request running, and the object cannot be
 * restarted under it (`evictDurableObject` then waits until the test times out).
 */
async function fetchWorker(input: Request): Promise<Response> {
  const response = await SELF.fetch(input);
  const body = await response.arrayBuffer();
  return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers });
}

/** Calls a route through the Worker's own fetch handler and returns the schema-checked body. */
async function ok<N extends RouteName>(token: string, name: N, input?: RouteInput<N>): Promise<RouteResponse<N>> {
  const response = await fetchWorker(request(token, name, input));
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`${name} failed with ${response.status}: ${JSON.stringify(body)}`);
  return ROUTES[name].response.parse(body) as RouteResponse<N>;
}

const csv = (header: string, rows: string[][]) => [header, ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n";
const user = (id: string, username: string, given: string, family: string) =>
  [id, "", "", "true", username, "", given, family, "", "", "", "", "", "", "", "", "", "", "", "", "", "org-nf-high", ""];

/** A OneRoster export for Northfield's English 9: Rivera, Amara and a student new to the district. */
function rosterExport(): Record<string, string> {
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

const ESSAY_RUBRIC = {
  rubricId: "rbr_essay-basics",
  version: 1,
  title: "Essay basics",
  criteria: [{
    id: "length",
    title: "Length",
    levels: [{ id: "short", label: "Too short", points: 0 }, { id: "enough", label: "Long enough", points: 4 }],
    checks: [{ id: "word-count", evaluatorId: "writing.structure", visibility: "student-visible", config: { minWords: 5 } }],
  }],
};

const ESSAY_TEXT = "School should start later because sleep matters [1]. Studies agree [2].";

// One district object holds the whole district, so the tests share it and run in order: each later
// test reads what an earlier one wrote, across a restart.
describe("the district Worker", () => {
  let assignmentId = "";
  let submissionId = "";
  let artifactId = "";

  it("refuses a request without a valid Access assertion", async () => {
    expect((await fetchWorker(request(undefined, "me.get"))).status).toBe(401);
    expect((await fetchWorker(request("not-a-token", "me.get"))).status).toBe(401);
    const otherAudience = await assertion("nf-0001", { aud: "another-application" });
    expect((await fetchWorker(request(otherAudience, "me.get"))).status).toBe(401);
    // A valid assertion for someone the directory does not know proves no principal, and shows
    // the caller the sign-in an administrator would add. An unverified one names nobody.
    const unlinked = await fetchWorker(request(await assertion("nobody-here"), "me.get"));
    expect(unlinked.status).toBe(401);
    expect(await unlinked.json()).toMatchObject({ code: "unauthenticated", unlinkedSignIn: { issuer: ACCESS_ISSUER, subject: "nobody-here" } });
    for (const token of [undefined, "not-a-token", otherAudience]) {
      expect(await (await fetchWorker(request(token, "me.get"))).json()).not.toHaveProperty("unlinkedSignIn");
    }
    expect((await fetchWorker(new Request("https://district.example/health"))).status).toBe(404);
  });

  it("accepts an assertion for each application CF_ACCESS_AUD lists, and for no other", async () => {
    const subject = NORTHFIELD.principals.find((p) => p.id === NF.rivera)!.externalIdentities[0]!.subject;
    for (const aud of [ACCESS_AUDIENCE, WORKSHOP_ACCESS_AUDIENCE, [WORKSHOP_ACCESS_AUDIENCE, "another-application"]]) {
      expect(await ok(await assertion(subject, { aud }), "me.get")).toMatchObject({ principalId: NF.rivera });
    }
    // The list's empty and blank entries are not audiences.
    for (const aud of ["another-application", "", " ", `${ACCESS_AUDIENCE},${WORKSHOP_ACCESS_AUDIENCE}`]) {
      expect((await fetchWorker(request(await assertion(subject, { aud }), "me.get"))).status).toBe(401);
    }
    // The connector's connect page is on the Workshop's hostname, so that is the assertion it forwards.
    const fromWorkshop = new Request("https://workshop.example/gatekeeper/educateos/connect", {
      headers: { "cf-access-jwt-assertion": await assertion(subject, { aud: WORKSHOP_ACCESS_AUDIENCE }) },
    });
    expect(await env.TOOLS.authenticate(fromWorkshop)).toEqual({ principalId: NF.rivera, districtId: NORTHFIELD.district.id });
  });

  it("answers the liveness probe without a sign-in, and nothing else beside /api", async () => {
    const live = await fetchWorker(new Request("https://district.example/healthz"));
    expect(live.status).toBe(200);
    expect(await live.text()).toBe("ok");
    expect((await fetchWorker(new Request("https://district.example/healthz/me"))).status).toBe(404);
  });

  it("writes the roster, an assignment and a submission through /api", async () => {
    const admin = await signIn(NF.admin);
    const applied = await ok(admin, "admin.applyRoster", { body: { files: rosterExport() } });
    expect(applied.applied).toBe(true);

    const teacher = await signIn(NF.rivera);
    const competency = await district().approveCatalogSeed(NF.admin);
    const item = await ok(teacher, "teacher.importResource", { params: { offeringId: NF.eng9 }, body: { url: "https://open-lessons.example/persuasive-writing" } }) as { id: string };
    const release = await ok(teacher, "teacher.approveResource", { params: { itemId: item.id }, body: { alignments: [] } }) as {
      descriptor: { id: string; release: { version: string } };
    };
    const resource = { resourceId: release.descriptor.id, version: release.descriptor.release.version };
    const rubric = await ok(teacher, "teacher.signRubric", { params: { offeringId: NF.eng9 }, body: { rubric: ESSAY_RUBRIC } });
    const draft = await ok(teacher, "teacher.createActivity", {
      params: { offeringId: NF.eng9 },
      body: {
        activity: {
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
        },
      },
    });
    await ok(teacher, "teacher.publishActivity", { params: { definitionId: draft.id } });
    const installed = await ok(teacher, "teacher.installActivity", {
      params: { definitionId: draft.id },
      body: { offeringId: NF.eng9, assignment: { rubric: { rubricId: rubric.rubricId, version: rubric.version } } },
    });
    assignmentId = installed.assignment.id;

    const student = await signIn(NF.amara);
    const workspace = await ok(student, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
    const created = await ok(student, "student.createArtifact", {
      body: { workspaceId: workspace.id, type: "document", title: "Later start essay", content: { kind: "text", mediaType: "text/markdown", text: ESSAY_TEXT } },
    });
    const receipt = await ok(student, "student.submit", {
      params: { assignmentId },
      body: { revisions: [{ artifactId: created.artifact.id, revisionId: created.head.id }] },
    });
    submissionId = receipt.submissionId;
    artifactId = created.artifact.id;
  });

  it("reads all of it back after the district's object restarts", async () => {
    await evictDurableObject(district());

    // The student the roster added signs in.
    const newcomer = await ok(await assertion("nf-s-2099"), "me.get");
    expect(newcomer).toMatchObject({ kind: "student", displayName: "Robin Newcomer" });
    const teacher = await signIn(NF.rivera);
    const roster = await ok(teacher, "teacher.roster", { params: { offeringId: NF.eng9 } });
    expect(roster.map((entry: { displayName: string }) => entry.displayName)).toContain("Amara Okafor");

    // The assignment, the submission and the submitted essay's content.
    const assignments = await ok(teacher, "teacher.listAssignments", { params: { offeringId: NF.eng9 } });
    expect(assignments.map((a: { id: string }) => a.id)).toContain(assignmentId);
    const submissions = await ok(teacher, "teacher.listSubmissions", { params: { assignmentId } });
    expect(submissions.map((s: { id: string }) => s.id)).toContain(submissionId);
    const content = await ok(teacher, "teacher.submittedContent", { params: { submissionId, artifactId } });
    expect(JSON.stringify(content)).toContain("sleep matters");

    // Terms, offerings, principals and enrollments, the roster's among them, are rows in the tables
    // D1 would hold them in.
    await runInDurableObject(district(), (_instance, state) => {
      const count = (table: string) => Number(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n);
      expect(count("academic_terms")).toBeGreaterThanOrEqual(NORTHFIELD.terms.length);
      expect(count("academic_offerings")).toBeGreaterThanOrEqual(NORTHFIELD.offerings.length);
      expect(count("academic_principals")).toBeGreaterThan(NORTHFIELD.principals.length);
      expect(count("academic_enrollments")).toBeGreaterThan(NORTHFIELD.enrollments.length);
    });
  });

  it("answers the AI call guard through its entrypoint", async () => {
    const directory = await env.GUARD.ledgerDirectory();
    expect(directory.district.id).toBe(NORTHFIELD.district.id);
    // Nobody has linked a Workshop user yet, so none resolves.
    expect(await env.GUARD.guardSubject({ workshopUser: "workshop-user-1" })).toBeNull();
  });

  it("persists an admin-confirmed student Workshop link and exposes it only through the guard", async () => {
    // An email-keyed account the principal migration aliased; a `principal:` key needs no link.
    const workshopUser = "amara-migrated@example.com";
    const student = await signIn(NF.amara);
    expect(await env.GUARD.guardSubject({ workshopUser })).toBeNull();
    expect((await fetchWorker(request(student, "admin.workshopUserLinks"))).status).toBe(403);
    const admin = await signIn(NF.admin);
    const link = await ok(admin, "admin.linkWorkshopUser", { body: { workshopUser, principalId: NF.amara } });
    expect(link.confirmedBy).toBe(NF.admin);
    expect((await fetchWorker(request(admin, "admin.linkWorkshopUser", { body: { workshopUser, principalId: NF.amara } }))).status).toBe(409);
    await evictDurableObject(env.DISTRICT.getByName(NORTHFIELD.district.id));
    expect(await ok(admin, "admin.workshopUserLinks")).toContainEqual(link);
    expect(await env.GUARD.guardSubject({ workshopUser })).toMatchObject({ kind: "student", roles: [], principal: { principalId: NF.amara } });
  });

  it("queues a school tool's write for a person, and decides it after a restart", async () => {
    const tools = await env.TOOLS.listTools();
    expect(tools.map((t) => t.name)).toContain("create_term");

    const signedIn = new Request("https://district.example/", { headers: { "cf-access-jwt-assertion": await signIn(NF.admin) } });
    const admin = await env.TOOLS.authenticate(signedIn);
    expect(admin).toEqual({ principalId: NF.admin, districtId: NORTHFIELD.district.id });
    expect(await env.TOOLS.authenticate(new Request("https://district.example/"))).toBeNull();

    // On the agent channel a read answers at once (SCHO-285): it changes nothing to confirm.
    const teacher = await env.TOOLS.authenticate(new Request("https://district.example/", { headers: { "cf-access-jwt-assertion": await signIn(NF.rivera) } }));
    const mine = await env.TOOLS.callTool(teacher!, "my_enrollments", {});
    expect(mine).toMatchObject({ status: "ok" });
    expect(JSON.stringify((mine as { value: unknown }).value)).toContain(NF.eng9);
    expect(await env.TOOLS.callTool(admin!, "list_terms", {})).toMatchObject({ status: "ok" });

    // Every directory change waits for a person.
    const queued = await env.TOOLS.callTool(admin!, "create_term", { name: "Spring 2027", startsOn: "2027-01-25", endsOn: "2027-06-11" });
    expect(queued).toMatchObject({ status: "approval-required" });
    const approvalId = (queued as { approvalId: string }).approvalId;

    // The queue is in the district's storage, so the decision survives a restart, and is final.
    await evictDurableObject(district());
    expect(await env.TOOLS.declineChange(admin!, approvalId, "Terms come from the roster.")).toMatchObject({ status: "declined", approvalId });
    expect(await env.TOOLS.approveChange(admin!, approvalId)).toMatchObject({ status: "error" });
  });

  it("serves the /api surface to the gatekeeper's verified principal, over its entrypoint", async () => {
    const as = (principalId: string, districtId: string = NORTHFIELD.district.id) => ({ principalId, districtId }) as never;
    const serve = async <N extends RouteName>(principalId: string, name: N, input?: RouteInput<N>, districtId?: string) => {
      const response = await env.TOOLS.serveAs(as(principalId, districtId), request(undefined, name, input));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    // A GET, as the person's own sign-in would see it, with no assertion on the request.
    const roster = await serve(NF.rivera, "teacher.roster", { params: { offeringId: NF.eng9 } });
    expect(roster.status).toBe(200);
    expect(roster.body).toStrictEqual(await ok(await signIn(NF.rivera), "teacher.roster", { params: { offeringId: NF.eng9 } }));

    // A POST, as the person's own action: the student opens their personal workspace.
    const opened = await serve(NF.amara, "student.openPersonalWorkspace");
    expect(opened.status).toBe(200);
    expect(ROUTES["student.openPersonalWorkspace"].response.parse(opened.body)).toMatchObject({ kind: "personal" });

    // Another district's principal, someone unknown, and the onboarding route are refused. (An
    // inactive principal is refused too; the district application's own suite covers that, since
    // this district's principals are the roster's to deactivate.)
    expect(await serve(NF.rivera, "me.get", undefined, "dst_riverbend")).toMatchObject({ status: 401, body: { code: "unauthenticated" } });
    expect(await serve("prn_nf-nobody", "me.get")).toMatchObject({ status: 401, body: { code: "unauthenticated" } });
    // Refused before its body is read: the district closes the body, or the later tests hang on it.
    expect(await serve(NF.admin, "onboarding.redeemGuardianInvitation", { body: { token: "x".repeat(20) } }))
      .toMatchObject({ status: 403, body: { code: "forbidden" } });
  });

  // Discussions (SCHO-190).
  it("keeps a class discussion and its moderation across a restart", async () => {
    const teacher = await signIn(NF.rivera);
    const student = await signIn(NF.amara);
    const topic = await ok(teacher, "teacher.createTopic", { params: { offeringId: NF.eng9 }, body: { title: "Later start?", prompt: "Say why." } });
    const post = await ok(student, "student.createPost", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { body: "Sleep matters." } });
    await ok(student, "student.createPost", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { body: "Also, buses.", parentId: post.id } });
    await ok(teacher, "teacher.moderatePost", { params: { offeringId: NF.eng9, postId: post.id }, body: { decision: "hide" } });

    await evictDurableObject(district());
    const thread = await ok(teacher, "teacher.discussionThread", { params: { offeringId: NF.eng9, topicId: topic.id } });
    expect(thread.posts.map((p) => [p.body, p.status])).toStrictEqual([["Sleep matters.", "hidden"], ["Also, buses.", "visible"]]);
    const seen = await ok(student, "student.discussionThread", { params: { offeringId: NF.eng9, topicId: topic.id } });
    expect(seen.posts.map((p) => p.status)).toStrictEqual(["withdrawn", "visible"]);
    expect((await ok(teacher, "teacher.moderationQueue", { params: { offeringId: NF.eng9 } })).recent.map((e) => e.action)).toStrictEqual(["hide"]);
  });
});

// Guardians (ADR-0012, SCHO-188)
describe("guardian onboarding in the district Worker", () => {
  it("keeps an invitation, the guardian's sign-in request and the relationship across restarts, until the guardian reads their child's classes", async () => {
    const admin = await signIn(NF.admin);
    const invited = await ok(admin, "admin.inviteGuardian", { params: { studentId: NF.amara }, body: { guardianDisplayName: "Gina Okafor" } });
    const token = new URLSearchParams(new URL(invited.invitationUrl).hash.slice(1)).get("invitation")!;
    const gina = await assertion("access-gina-okafor");
    expect(await ok(gina, "onboarding.redeemGuardianInvitation", { body: { token } })).toEqual({ outcome: "awaiting-approval" });

    await evictDurableObject(district());
    const { pendingSignIns } = await ok(admin, "admin.studentGuardians", { params: { studentId: NF.amara } });
    expect(pendingSignIns).toHaveLength(1);
    await ok(admin, "admin.approveIdentityRequest", { params: { requestId: pendingSignIns[0]!.requestId } });

    await evictDurableObject(district());
    await ok(admin, "admin.confirmGuardian", { params: { relationshipId: invited.relationship.id } });
    // The spent invitation stays spent after a restart.
    const spent = await fetchWorker(request(await assertion("someone-else"), "onboarding.redeemGuardianInvitation", { body: { token } }));
    expect({ status: spent.status, body: await spent.json() }).toMatchObject({ status: 404, body: { code: "not-found" } });

    await evictDurableObject(district());
    expect(await ok(gina, "me.get")).toMatchObject({ kind: "guardian", principalId: invited.invitation.reservedGuardianPrincipalId });
    expect(await ok(gina, "guardian.listChildren")).toEqual([{ studentPrincipalId: NF.amara, displayName: "Amara Okafor" }]);
    expect((await ok(gina, "guardian.childOfferings", { params: { studentId: NF.amara } })).map((o) => o.offering.id)).toContain(NF.eng9);
    const course = await ok(gina, "guardian.childCourse", { params: { studentId: NF.amara, offeringId: NF.eng9 } });
    expect(course.course.title).toBe("English 9");

    // Communication (SCHO-189): the weekly family digest goes out over the same stored relationship.
    const preview = await ok(admin, "admin.previewDigest", { params: { guardianPrincipalId: invited.invitation.reservedGuardianPrincipalId } });
    expect(preview.digest.children.map((child) => child.studentPrincipalId)).toEqual([NF.amara]);
    expect(preview.digest.children[0]!.offerings.map((offering) => offering.offeringId)).toContain(NF.eng9);
  });
});
