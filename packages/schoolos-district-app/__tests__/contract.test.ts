import { describe, expect, it } from "vitest";
import { ROUTES, pathParameterNames, type RouteSpec } from "../src/index.ts";
import {
  bootDistrict,
  expectError,
  NF,
  RB,
  RIVERBEND,
  studentSubmitsEssay,
  teacherSetsUpEssay,
} from "./support.ts";

describe("the route table", () => {
  it("names every path parameter in its params schema, and nothing else", () => {
    for (const [name, spec] of Object.entries(ROUTES) as [string, RouteSpec][]) {
      const declared = Object.keys(spec.params?.shape ?? {}).toSorted();
      expect([name, declared]).toStrictEqual([name, pathParameterNames(spec.path).toSorted()]);
    }
  });

  it("puts every route under /api/<surface>, and gives every POST a body schema", () => {
    for (const [name, spec] of Object.entries(ROUTES) as [string, RouteSpec][]) {
      expect(spec.path.startsWith(spec.surface === "me" ? "/api/me" : `/api/${spec.surface}/`), name).toBe(true);
      expect(name.startsWith(`${spec.surface}.`), name).toBe(true);
      if (spec.method === "POST") expect(spec.body, name).toBeDefined();
    }
  });
});

describe("request handling", () => {
  it("answers 401 without a credential, and with one from another IdP", async () => {
    const district = await bootDistrict();
    expectError(await district.call(undefined, "me.get"), 401, "unauthenticated");
    expectError(await district.call("not-a-token", "me.get"), 401, "unauthenticated");
  });

  it("answers 404 for an unknown route, and for one outside /api", async () => {
    const district = await bootDistrict();
    const token = district.tokenFor(NF.amara);
    for (const path of ["/api/nope", "/health", "/api/student/workspaces/personal/extra"]) {
      const response = await district.app.fetch(new Request(`https://district.example${path}`, { headers: { authorization: `Bearer ${token}` } }));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "not-found" });
    }
  });

  it("validates path, query and body, rejecting unknown fields without echoing values", async () => {
    const district = await bootDistrict();
    const amara = district.tokenFor(NF.amara);
    const badId = await district.call(amara, "student.getArtifact", { params: { artifactId: "wsp_not-an-artifact" } });
    expectError(badId, 400, "validation-failed");
    const extra = await district.call(amara, "student.createArtifact", {
      body: { workspaceId: "wsp_x", type: "document", title: "t", content: { kind: "text", mediaType: "text/plain", text: "x" }, role: "teacher" } as never,
    });
    expectError(extra, 400, "validation-failed");
    expect((extra.body as { message: string }).message).toMatch(/unknown field\(s\) role/);
    const response = await district.app.fetch(new Request("https://district.example/api/student/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${amara}`, "content-type": "application/json" },
      body: "{ SECRET-NOT-JSON",
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("SECRET");
  });

  it("serves each surface only to its principal kind", async () => {
    const district = await bootDistrict();
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.listOfferings"), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.amara), "admin.health"), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.rivera), "student.listWorkspaces"), 403, "forbidden");
    // Within a surface, policy decides: a teacher is not a district administrator.
    expectError(await district.call(district.tokenFor(NF.rivera), "admin.health"), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.rivera), "admin.aiUsage"), 403, "forbidden");
  });

  it("gives every request one correlation ID, which every policy decision it caused is audited under", async () => {
    const district = await bootDistrict();
    const amara = district.tokenFor(NF.amara);
    const workspace = await district.call(amara, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
    const listed = await district.call(amara, "student.listWorkspaces");
    expect(workspace.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(listed.correlationId).not.toBe(workspace.correlationId);
    const decisions = district.audit.events().filter((e) => e.correlationId === workspace.correlationId);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((e) => e.principalId === NF.amara)).toBe(true);

    const denied = await district.call(district.tokenFor(NF.rivera), "admin.health");
    expect(district.audit.events().filter((e) => e.correlationId === denied.correlationId)).toMatchObject([{ effect: "deny", resourceKind: "district" }]);
  });
});

describe("cross-district isolation", () => {
  it("rejects a Northfield token at Riverbend, though the same person teaches in both", async () => {
    const northfield = await bootDistrict();
    const riverbend = await bootDistrict(RIVERBEND);
    // Morgan Lee has the same IdP subject in both districts; only each district's own IdP is trusted.
    const nfMorgan = northfield.tokenFor(NF.morgan);
    expectError(await riverbend.call(nfMorgan, "me.get"), 401, "unauthenticated");
    expect((await riverbend.ok(riverbend.tokenFor("prn_rb-morgan-lee"), "me.get")).districtId).toBe("dst_riverbend");
  });

  it("finds no Northfield records through Riverbend's API", async () => {
    const northfield = await bootDistrict();
    const riverbend = await bootDistrict(RIVERBEND);
    const { assignment } = await teacherSetsUpEssay(northfield);
    const { receipt, artifact } = await studentSubmitsEssay(northfield, assignment.id);

    const rbTeacher = riverbend.tokenFor(RB.teacher);
    expectError(await riverbend.call(rbTeacher, "teacher.listSubmissions", { params: { assignmentId: assignment.id } }), 404, "not-found");
    expectError(await riverbend.call(rbTeacher, "teacher.getFeedback", { params: { submissionId: receipt.submissionId } }), 404, "not-found");
    expectError(await riverbend.call(rbTeacher, "teacher.roster", { params: { offeringId: NF.eng9 } }), 404, "not-found");
    const rbStudent = riverbend.tokenFor(RB.student);
    expectError(await riverbend.call(rbStudent, "student.getArtifact", { params: { artifactId: artifact.id } }), 404, "not-found");
    expectError(await riverbend.call(rbStudent, "student.getActivity", { params: { activityId: assignment.activityId } }), 404, "not-found");
  });
});

describe("privacy", () => {
  it("never lets a teacher list or read a student's personal workspace", async () => {
    const district = await bootDistrict();
    const amara = district.tokenFor(NF.amara);
    const personal = await district.ok(amara, "student.openPersonalWorkspace");
    await district.ok(amara, "student.createArtifact", {
      body: { workspaceId: personal.id, type: "document", title: "Journal", content: { kind: "text", mediaType: "text/plain", text: "PRIVATE-JOURNAL" } },
    });
    const course = await district.ok(amara, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });

    const rivera = district.tokenFor(NF.rivera);
    const listed = await district.ok(rivera, "teacher.listWorkspaces", { params: { offeringId: NF.eng9 } });
    expect(listed.map((w) => [w.kind, w.id])).toStrictEqual([["course", course.id]]);
    // A teacher sees a course workspace's record, never the reference to its contents.
    expect(listed[0]!.storageHandle).toBeUndefined();
    const probe = await district.call(rivera, "teacher.listWorkspaceArtifacts", { params: { workspaceId: personal.id } });
    expectError(probe, 404, "not-found");
    expect(JSON.stringify(probe.body)).not.toContain("PRIVATE-JOURNAL");
    // Nor can a classmate.
    expectError(await district.call(district.tokenFor(NF.elena), "student.listArtifacts", { params: { workspaceId: personal.id } }), 404, "not-found");
  });

  it("never lets a district administrator read student work", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const { receipt, artifact, workspace } = await studentSubmitsEssay(district, assignment.id);
    const admin = district.tokenFor(NF.admin);
    expectError(await district.call(admin, "teacher.submittedContent", { params: { submissionId: receipt.submissionId, artifactId: artifact.id } }), 404, "not-found");
    // Administrators oversee course structure, so the assignment is visible; none of its submissions are.
    expect(await district.ok(admin, "teacher.listSubmissions", { params: { assignmentId: assignment.id } })).toStrictEqual([]);
    expectError(await district.call(admin, "teacher.listWorkspaceArtifacts", { params: { workspaceId: workspace.id } }), 404, "not-found");
    expectError(await district.call(admin, "teacher.runCi", { params: { submissionId: receipt.submissionId } }), 404, "not-found");
    // Health is counts only.
    const health = await district.ok(admin, "admin.health");
    expect(health.work.submissions).toBe(1);
    expect(JSON.stringify(health)).not.toMatch(/start later|Amara/);
  });

  it("keeps a teacher out of classes they do not teach", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const { receipt } = await studentSubmitsEssay(district, assignment.id);
    const morgan = district.tokenFor(NF.morgan);
    expectError(await district.call(morgan, "teacher.listSubmissions", { params: { assignmentId: assignment.id } }), 404, "not-found");
    expectError(await district.call(morgan, "teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 1, maxPoints: 1 } } }), 404, "not-found");
    expectError(await district.call(morgan, "teacher.importResource", { params: { offeringId: NF.eng9 }, body: { url: "https://open-lessons.example/osmosis-lab" } }), 403, "forbidden");
  });

  it("keeps a student to their own work and classes", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const { receipt, artifact } = await studentSubmitsEssay(district, assignment.id);
    const elena = district.tokenFor(NF.elena);
    expectError(await district.call(elena, "student.getArtifact", { params: { artifactId: artifact.id } }), 404, "not-found");
    expectError(await district.call(elena, "student.getFeedback", { params: { submissionId: receipt.submissionId } }), 404, "not-found");
    expect(await district.ok(elena, "student.listSubmissions", { params: { assignmentId: assignment.id } })).toStrictEqual([]);
    // Dmitri was dropped from English 9: he gets no workspace for it.
    expectError(await district.call(district.tokenFor(NF.dmitri), "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } }), 403, "forbidden");
    // A student cannot submit someone else's revision.
    const own = await district.ok(elena, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
    expect(own.ownerPrincipalId).toBe(NF.elena);
    const stolen = await district.call(elena, "student.submit", { params: { assignmentId: assignment.id }, body: { revisions: [{ artifactId: artifact.id, revisionId: receipt.items[0]!.revisionId }] } });
    expect([403, 404]).toContain(stolen.status);
  });
});

describe("projects (W03)", () => {
  it("are unavailable unless the district enables them, and then save and list versions", async () => {
    const off = await bootDistrict();
    const amara = off.tokenFor(NF.amara);
    const personal = await off.ok(amara, "student.openPersonalWorkspace");
    const body = { workspaceId: personal.id, type: "notebook" as const, title: "Lab notes", files: [{ path: "notes.md", text: "# Day 1" }], message: "Start" };
    expectError(await off.call(amara, "student.createProject", { body }), 503, "unavailable");

    const on = await bootDistrict(undefined, { projects: { plan: undefined } });
    const token = on.tokenFor(NF.amara);
    const workspace = await on.ok(token, "student.openPersonalWorkspace");
    const project = await on.ok(token, "student.createProject", { body: { ...body, workspaceId: workspace.id } });
    await on.ok(token, "student.saveProject", { params: { artifactId: project.artifact.id }, body: { files: [{ path: "notes.md", text: "# Day 1\nMore." }], message: "More" } });
    const versions = await on.ok(token, "student.projectHistory", { params: { artifactId: project.artifact.id } });
    expect(versions.map((v) => v.message)).toStrictEqual(["More", "Start"]);
    expectError(await on.call(on.tokenFor(NF.rivera), "teacher.listWorkspaceArtifacts", { params: { workspaceId: workspace.id } }), 404, "not-found");
  });
});
