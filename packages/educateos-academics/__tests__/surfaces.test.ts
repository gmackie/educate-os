import { describe, expect, it } from "vitest";
import { EducateOsErrorBody, type Caller, type VerifiedPrincipal } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import {
  ACADEMIC_OPERATIONS,
  AcademicDirectory,
  createAcademicsHandler,
  createAcademicTools,
  ERROR_STATUS,
  invokeOperation,
  RoleTableAuthorizer,
  storePrincipalFacts,
} from "../src/index.ts";
import { ALL_LOCAL, directoryFor, NF, RB_ADMIN, ROSTER_EXTERNAL } from "./setup.ts";

const BASE = "https://academics.northfield.example";

/** Resolves a bearer token that is simply the principal ID; enough to exercise the handler. */
function handlerFor(directory: AcademicDirectory, principals: Caller[]) {
  const byToken = new Map<string, VerifiedPrincipal>(principals.map((c) => [c.principal.principalId, c.principal]));
  return createAcademicsHandler({
    directory,
    resolvePrincipal: async (request) => byToken.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""),
  });
}

async function call(
  handler: (request: Request) => Promise<Response>,
  caller: Caller | undefined,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers = new Headers();
  if (caller !== undefined) headers.set("authorization", `Bearer ${caller.principal.principalId}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await handler(new Request(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json() as unknown };
}

/** One request as an HTTP route and as the matching tool call. */
interface Case {
  name: string;
  caller: Caller;
  http: [method: string, path: string, body?: unknown];
  tool: [name: keyof typeof ACADEMIC_OPERATIONS, args: unknown];
}

const CASES: Case[] = [
  { name: "teacher reads own roster", caller: NF.morgan, http: ["GET", "/offerings/off_nf-bio-fall-p2/roster"], tool: ["get_roster", { offeringId: "off_nf-bio-fall-p2" }] },
  { name: "student reads another roster", caller: NF.chidi, http: ["GET", "/offerings/off_nf-bio-fall-p2/roster"], tool: ["get_roster", { offeringId: "off_nf-bio-fall-p2" }] },
  { name: "student reads own enrollments", caller: NF.amara, http: ["GET", "/me/enrollments"], tool: ["my_enrollments", {}] },
  { name: "student lists another's enrollments", caller: NF.amara, http: ["GET", "/enrollments?principalId=prn_nf-student-elena"], tool: ["list_enrollments", { principalId: "prn_nf-student-elena" }] },
  { name: "admin lists active terms", caller: NF.admin, http: ["GET", "/terms?state=active"], tool: ["list_terms", { state: "active" }] },
  { name: "illegal term transition", caller: NF.admin, http: ["POST", "/terms/trm_nf-2026-spring/transition", { to: "active" }], tool: ["transition_term", { termId: "trm_nf-2026-spring", to: "active" }] },
  { name: "write to an externally owned type", caller: NF.admin, http: ["POST", "/enrollments", { offeringId: "off_nf-bio-fall-p2", principalId: "prn_nf-student-felix", role: "student" }], tool: ["create_enrollment", { offeringId: "off_nf-bio-fall-p2", principalId: "prn_nf-student-felix", role: "student" }] },
  { name: "student deactivates own enrollment", caller: NF.amara, http: ["POST", "/enrollments/enr_nf-02/deactivate", {}], tool: ["deactivate_enrollment", { enrollmentId: "enr_nf-02" }] },
  { name: "school admin creates a term", caller: NF.highPrincipal, http: ["POST", "/terms", { name: "T", startsOn: "2026-09-01", endsOn: "2026-12-01" }], tool: ["create_term", { name: "T", startsOn: "2026-09-01", endsOn: "2026-12-01" }] },
  { name: "cross-district admin reads a term", caller: RB_ADMIN, http: ["GET", "/terms/trm_nf-2026-fall"], tool: ["get_term", { termId: "trm_nf-2026-fall" }] },
  { name: "unknown field is rejected", caller: NF.admin, http: ["PATCH", "/terms/trm_nf-2026-fall", { state: "completed" }], tool: ["update_term", { termId: "trm_nf-2026-fall", state: "completed" }] },
  { name: "admin graduates a roster-owned principal", caller: NF.admin, http: ["POST", "/principals/prn_nf-student-amara/status", { status: "graduated" }], tool: ["set_principal_status", { principalId: "prn_nf-student-amara", status: "graduated" }] },
  { name: "admin renames a roster-owned principal", caller: NF.admin, http: ["PATCH", "/principals/prn_nf-student-amara", { displayName: "A" }], tool: ["update_principal", { principalId: "prn_nf-student-amara", displayName: "A" }] },
  { name: "student reactivates themself", caller: NF.amara, http: ["POST", "/principals/prn_nf-student-amara/reactivate", {}], tool: ["reactivate_principal", { principalId: "prn_nf-student-amara" }] },
  { name: "malformed ID is rejected", caller: NF.admin, http: ["GET", "/offerings/sch_nf-high"], tool: ["get_offering", { offeringId: "sch_nf-high" }] },
];

describe("the HTTP handler and the tools", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("decide identically: %s", async (_, testCase) => {
    const viaHttp = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    const viaTool = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    const handler = handlerFor(viaHttp.directory, [testCase.caller]);
    const tool = createAcademicTools(viaTool.directory).find((t) => t.name === testCase.tool[0])!;

    const [method, path, body] = testCase.http;
    const http = await call(handler, testCase.caller, method, path, body);
    const outcome = await tool.handler(testCase.caller.principal, testCase.tool[1]);

    if (outcome.ok) {
      expect(http.status).toBeLessThan(300);
      expect(http.body).toEqual(outcome.value);
      // What both return is what the descriptor declares.
      expect(ACADEMIC_OPERATIONS[testCase.tool[0]].output.safeParse(outcome.value).success).toBe(true);
    } else {
      // Each invocation has its own correlation ID; everything else is identical.
      const { correlationId: httpId, ...httpError } = EducateOsErrorBody.parse(http.body);
      const { correlationId: toolId, ...toolError } = outcome.error;
      expect(httpError).toEqual(toolError);
      expect([httpId, toolId]).toEqual([expect.any(String), expect.any(String)]);
      expect(http.status).toBe(ERROR_STATUS[outcome.error.code]);
    }
    // And they leave the two stores in the same state.
    expect((await viaHttp.store.load()).snapshot).toEqual((await viaTool.store.load()).snapshot);
  });

  it("cover every operation exposed to agents with both a route and a tool", () => {
    const { directory } = directoryFor();
    const tools = createAcademicTools(directory);
    const exposed = Object.values(ACADEMIC_OPERATIONS).filter((o) => o.channels.includes("mcp-agent")).map((o) => o.name);
    expect(tools.map((t) => t.name).toSorted()).toEqual(exposed.toSorted());
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("produce the expected outcomes for the shared cases", async () => {
    const { directory } = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    const tools = new Map(createAcademicTools(directory).map((t) => [t.name, t]));
    const codes: Record<string, string> = {};
    for (const c of CASES) {
      const outcome = await tools.get(c.tool[0])!.handler(c.caller.principal, c.tool[1]);
      codes[c.name] = outcome.ok ? "ok" : outcome.error.code;
    }
    expect(codes).toEqual({
      "teacher reads own roster": "ok",
      "student reads another roster": "not-found",
      "student reads own enrollments": "ok",
      "student lists another's enrollments": "ok",
      "admin lists active terms": "ok",
      "illegal term transition": "conflict",
      "write to an externally owned type": "conflict",
      // Routing a write names the district's source of record, so it waits until the caller is
      // authorized: a caller who may not make the change learns nothing about who owns it.
      "student deactivates own enrollment": "forbidden",
      "school admin creates a term": "forbidden",
      "cross-district admin reads a term": "not-found",
      "unknown field is rejected": "validation-failed",
      "admin graduates a roster-owned principal": "conflict",
      "admin renames a roster-owned principal": "conflict",
      "student reactivates themself": "not-found",
      "malformed ID is rejected": "validation-failed",
    });
  });
});

describe("the operation descriptors", () => {
  it("keep identity links away from agents: create_principal is not a tool and its call is refused", async () => {
    const { directory, store } = directoryFor(NORTHFIELD, { authority: ALL_LOCAL });
    expect(ACADEMIC_OPERATIONS.create_principal.channels).not.toContain("mcp-agent");
    expect(createAcademicTools(directory).map((t) => t.name)).not.toContain("create_principal");

    const before = (await store.load()).snapshot;
    const input = { kind: "student", displayName: "Robin Park", identity: { issuer: NORTHFIELD.district.trustedIssuers[0]!, subject: "robin" } };
    for (const channel of ["mcp-tool", "agent"] as const) {
      const outcome = await invokeOperation(ACADEMIC_OPERATIONS.create_principal, directory, { ...NF.admin, channel }, input);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "forbidden", message: "create_principal is not available through mcp-agent.", correlationId: expect.any(String) },
      });
    }
    expect((await store.load()).snapshot).toEqual(before);
  });

  it("refuse a channel before reading the input, so an unexposed call learns nothing from validation", async () => {
    const { directory } = directoryFor();
    // No academic operation is exposed to trusted jobs: a system caller is refused even with junk input.
    for (const operation of Object.values(ACADEMIC_OPERATIONS)) {
      expect(operation.channels).not.toContain("internal-job");
      const outcome = await invokeOperation(operation, directory, { ...NF.admin, channel: "system" }, { junk: true });
      expect(outcome).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
  });

  it("route a write by its domain's binding only once the caller is authorized for it", async () => {
    const { directory, store } = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    const before = (await store.load()).snapshot;
    const update = { offeringId: "off_nf-bio-fall-p2", sectionName: "P9" };
    const refusal = async (caller: Caller) => {
      const outcome = await invokeOperation(ACADEMIC_OPERATIONS.update_offering, directory, caller, update);
      if (outcome.ok) throw new Error("expected a refusal");
      return outcome.error;
    };
    // The district admin may edit the offering, so they learn where to make the change instead.
    expect(await refusal(NF.admin)).toEqual({
      code: "conflict",
      message: "Course offerings are owned by external:oneroster; change them there and let its sync update EducateOS.",
      correlationId: expect.any(String),
    });
    // A student outside the class and an admin from another district learn nothing about its owner.
    for (const caller of [NF.amara, RB_ADMIN]) {
      const error = await refusal(caller);
      expect(error.code).toBe("not-found");
      expect(error.message).not.toMatch(/oneroster|owned/);
    }
    expect((await store.load()).snapshot).toEqual(before);
    expect(await invokeOperation(ACADEMIC_OPERATIONS.get_offering, directory, NF.admin, { offeringId: "off_nf-bio-fall-p2" })).toMatchObject({ ok: true });
  });

  it("route a roster-owned write by owner only for a caller who may make it", async () => {
    const { directory } = directoryFor(NORTHFIELD, { authority: ROSTER_EXTERNAL });
    const deactivate = (caller: Caller) => invokeOperation(ACADEMIC_OPERATIONS.deactivate_enrollment, directory, caller, { enrollmentId: "enr_nf-02" });
    const student = await deactivate(NF.amara);
    expect(student).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(JSON.stringify(student)).not.toMatch(/oneroster|owned/);
    expect(await deactivate(NF.admin)).toMatchObject({
      ok: false,
      error: { code: "conflict", message: "Enrollments are owned by external:oneroster; change them there and let its sync update EducateOS." },
    });
  });

  it("classify every operation: reads are list or read actions and need no approval", () => {
    for (const operation of Object.values(ACADEMIC_OPERATIONS)) {
      expect(operation.version).toBe(1);
      if (operation.effect === "read") {
        expect(["list", "read"]).toContain(operation.action);
        expect(operation).toMatchObject({ idempotency: "inherent", approval: "none" });
      } else {
        expect(["create", "update"]).toContain(operation.action);
        expect(operation).toMatchObject({ effect: "write", approval: "confirm-agent" });
      }
    }
  });
});

describe("the HTTP handler", () => {
  it("authenticates before routing, so anonymous callers learn nothing about paths", async () => {
    const { directory } = directoryFor();
    const handler = handlerFor(directory, [NF.admin]);
    for (const path of ["/terms", "/no-such-route"]) {
      const response = await call(handler, undefined, "GET", path);
      expect(response).toEqual({ status: 401, body: { code: "unauthenticated", message: expect.any(String), correlationId: expect.any(String) } });
    }
  });

  it("creates with 201 and reads back", async () => {
    const { directory } = directoryFor();
    const handler = handlerFor(directory, [NF.admin]);
    const created = await call(handler, NF.admin, "POST", "/courses", { title: "Visual Arts", subject: "arts", gradeBand: "9-12" });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    expect(id).toMatch(/^crs_/);
    expect(await call(handler, NF.admin, "GET", `/courses/${id}`)).toEqual({ status: 200, body: created.body });
  });

  it("refuses a body field that would contradict the path", async () => {
    const { directory } = directoryFor();
    const handler = handlerFor(directory, [NF.admin]);
    const response = await call(handler, NF.admin, "PATCH", "/terms/trm_nf-2026-fall", { termId: "trm_nf-2026-spring", name: "Renamed" });
    expect(response.status).toBe(400);
    expect((await directory.getTerm(NF.admin, "trm_nf-2026-spring" as never)).name).toBe("Spring 2026");
  });

  it("refuses bodies that are not JSON objects, and server-assigned fields", async () => {
    const { directory } = directoryFor();
    const handler = handlerFor(directory, [NF.admin]);
    expect((await call(handler, NF.admin, "POST", "/terms", "not json")).status).toBe(400);
    expect((await call(handler, NF.admin, "POST", "/terms", [1])).status).toBe(400);
    const withId = await call(handler, NF.admin, "POST", "/schools", { id: "sch_chosen", name: "X", gradeBands: ["K"] });
    expect(withId.status).toBe(400);
  });

  it("answers unknown routes with a not-found error body", async () => {
    const { directory } = directoryFor();
    const handler = handlerFor(directory, [NF.admin]);
    const response = await call(handler, NF.admin, "DELETE", "/enrollments/enr_nf-02");
    expect(response.status).toBe(404);
    expect(EducateOsErrorBody.parse(response.body).code).toBe("not-found");
  });

  it("names in every error body the correlation ID its decisions were audited under", async () => {
    const audited: { request: unknown; correlationId: string | undefined }[] = [];
    const store = directoryFor().store;
    const facts = new RoleTableAuthorizer(storePrincipalFacts(store));
    const directory = new AcademicDirectory({
      store,
      authority: ALL_LOCAL,
      authorizer: {
        authorize: async (request, options) => {
          audited.push({ request, correlationId: options?.correlationId });
          return facts.authorize(request);
        },
      },
    });
    const handler = handlerFor(directory, [NF.amara]);
    const refused = await call(handler, NF.amara, "POST", "/enrollments/enr_nf-02/deactivate", {});
    expect(refused.status).toBe(403);
    const { correlationId } = EducateOsErrorBody.parse(refused.body);
    expect(correlationId).toEqual(expect.any(String));
    expect(audited.length).toBeGreaterThan(0);
    expect(audited.every((entry) => entry.correlationId === correlationId)).toBe(true);
  });
});
