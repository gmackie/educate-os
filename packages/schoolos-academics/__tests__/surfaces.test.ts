import { describe, expect, it } from "vitest";
import { SchoolOsErrorBody } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import {
  ACADEMIC_OPERATIONS,
  createAcademicsHandler,
  createAcademicTools,
  ERROR_STATUS,
  type AcademicDirectory,
  type Caller,
  type VerifiedPrincipal,
} from "../src/index.ts";
import { directoryFor, NF, RB_ADMIN, ROSTER_EXTERNAL } from "./setup.ts";

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
    } else {
      expect(SchoolOsErrorBody.parse(http.body)).toEqual(outcome.error);
      expect(http.status).toBe(ERROR_STATUS[outcome.error.code]);
    }
    // And they leave the two stores in the same state.
    expect((await viaHttp.store.load()).snapshot).toEqual((await viaTool.store.load()).snapshot);
  });

  it("cover every operation with both a route and a tool", () => {
    const { directory } = directoryFor();
    const tools = createAcademicTools(directory);
    expect(tools.map((t) => t.name).toSorted()).toEqual(Object.keys(ACADEMIC_OPERATIONS).toSorted());
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
      "student deactivates own enrollment": "forbidden",
      "school admin creates a term": "forbidden",
      "cross-district admin reads a term": "not-found",
      "unknown field is rejected": "validation-failed",
      "malformed ID is rejected": "validation-failed",
    });
  });
});

describe("the HTTP handler", () => {
  it("authenticates before routing, so anonymous callers learn nothing about paths", async () => {
    const { directory } = directoryFor();
    const handler = handlerFor(directory, [NF.admin]);
    for (const path of ["/terms", "/no-such-route"]) {
      const response = await call(handler, undefined, "GET", path);
      expect(response).toEqual({ status: 401, body: { code: "unauthenticated", message: expect.any(String) } });
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
    expect(SchoolOsErrorBody.parse(response.body).code).toBe("not-found");
  });
});
