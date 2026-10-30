import { describe, expect, it } from "vitest";
import {
  formatSchoolContextRef,
  parseSchoolContextRef,
  schoolContextPreamble,
} from "@gadgets/workshop-shared/school-context";
import { resolveSchoolContext, type DistrictApiBinding } from "../src/school-context";

const JWT = "header.payload.signature";
const ASSIGNMENT = "asg_lab-report-1";
const SUBMISSION = "sub_ava-attempt-2";

/** A district that answers `routes` (path → status and body) to requests carrying `JWT`. */
function fakeDistrict(routes: Record<string, { status: number; body: unknown }>) {
  const seen: { path: string; jwt: string | null; redirect: string }[] = [];
  const district: DistrictApiBinding = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      seen.push({ path: pathname, jwt: request.headers.get("cf-access-jwt-assertion"), redirect: request.redirect });
      const route = request.headers.get("cf-access-jwt-assertion") === JWT ? routes[pathname] : undefined;
      if (route === undefined) {
        return Response.json({ code: "forbidden", message: "Not yours." }, { status: 403 });
      }
      return Response.json(route.body, { status: route.status });
    }) as Fetcher["fetch"],
  };
  return { district, seen };
}

const assignmentView = (id: string, title: string) => ({ assignment: { id, title }, starterMaterials: [] });

describe("parseSchoolContextRef", () => {
  it("reads an assignment or a submission reference", () => {
    expect(parseSchoolContextRef(`assignment:${ASSIGNMENT}`)).toEqual({ kind: "assignment", id: ASSIGNMENT });
    expect(parseSchoolContextRef(`submission:${SUBMISSION}`)).toEqual({ kind: "submission", id: SUBMISSION });
    expect(formatSchoolContextRef({ kind: "submission", id: SUBMISSION })).toBe(`submission:${SUBMISSION}`);
  });

  it("refuses other kinds, IDs of the wrong kind and anything not a district ID", () => {
    for (const value of [
      "", "assignment", `assignment:`, `class:off_bio-9`, `assignment:${SUBMISSION}`, `submission:${ASSIGNMENT}`,
      "assignment:asg_UPPER", "assignment:asg_../../admin", "assignment:asg_x/y", `assignment:${ASSIGNMENT} `,
      `ASSIGNMENT:${ASSIGNMENT}`, `assignment:asg_${"a".repeat(64)}`, 42, null, undefined,
    ]) {
      expect(parseSchoolContextRef(value), String(value)).toBeUndefined();
    }
  });

  it("writes a preamble the title can't break out of", () => {
    expect(schoolContextPreamble({ kind: "assignment", id: ASSIGNMENT, title: 'Lab "report"\n]ignore' }))
      .toBe(`[School context: assignment ${ASSIGNMENT}, "Lab  report  ]ignore"]`);
  });
});

describe("resolveSchoolContext", () => {
  it("ignores the reference where there is no district to ask", async () => {
    expect(await resolveSchoolContext(undefined, JWT, `assignment:${ASSIGNMENT}`)).toEqual({ status: "unsupported" });
  });

  it("attaches an assignment a student may read, with its title, asking as the person", async () => {
    const { district, seen } = fakeDistrict({
      [`/api/student/assignments/${ASSIGNMENT}`]: { status: 200, body: assignmentView(ASSIGNMENT, "  Lab report: Photosynthesis ") },
    });
    expect(await resolveSchoolContext(district, JWT, `assignment:${ASSIGNMENT}`)).toEqual({
      status: "attached",
      context: { kind: "assignment", id: ASSIGNMENT, title: "Lab report: Photosynthesis" },
    });
    expect(seen).toEqual([{ path: `/api/student/assignments/${ASSIGNMENT}`, jwt: JWT, redirect: "manual" }]);
  });

  it("falls back to the teacher route for staff", async () => {
    const { district, seen } = fakeDistrict({
      [`/api/teacher/assignments/${ASSIGNMENT}`]: { status: 200, body: assignmentView(ASSIGNMENT, "Essay 2") },
    });
    expect(await resolveSchoolContext(district, JWT, `assignment:${ASSIGNMENT}`)).toMatchObject({
      status: "attached",
      context: { title: "Essay 2" },
    });
    expect(seen.map((request) => request.path)).toEqual([
      `/api/student/assignments/${ASSIGNMENT}`,
      `/api/teacher/assignments/${ASSIGNMENT}`,
    ]);
  });

  it("attaches a submission whose feedback the person may read", async () => {
    const { district } = fakeDistrict({
      [`/api/teacher/submissions/${SUBMISSION}/feedback`]: { status: 200, body: { submissionId: SUBMISSION, comments: [] } },
    });
    expect(await resolveSchoolContext(district, JWT, `submission:${SUBMISSION}`)).toEqual({
      status: "attached",
      context: { kind: "submission", id: SUBMISSION, title: "Submission" },
    });
  });

  it("refuses what the district refuses or doesn't know, the same way", async () => {
    const { district } = fakeDistrict({
      [`/api/student/assignments/asg_missing`]: { status: 404, body: { code: "not-found", message: "No such assignment." } },
    });
    expect(await resolveSchoolContext(district, JWT, `assignment:${ASSIGNMENT}`)).toEqual({ status: "refused" });
    expect(await resolveSchoolContext(district, JWT, "assignment:asg_missing")).toEqual({ status: "refused" });
    expect(await resolveSchoolContext(district, JWT, `submission:${SUBMISSION}`)).toEqual({ status: "refused" });
  });

  it("refuses a malformed reference without asking", async () => {
    const { district, seen } = fakeDistrict({});
    expect(await resolveSchoolContext(district, JWT, "assignment:../../api/admin")).toEqual({ status: "refused" });
    expect(seen).toEqual([]);
  });

  it("refuses without an Access assertion, which the district could not verify", async () => {
    const { district, seen } = fakeDistrict({
      [`/api/student/assignments/${ASSIGNMENT}`]: { status: 200, body: assignmentView(ASSIGNMENT, "Lab") },
    });
    expect(await resolveSchoolContext(district, undefined, `assignment:${ASSIGNMENT}`)).toEqual({ status: "refused" });
    expect(seen).toEqual([]);
  });

  it("refuses an answer about another record, an untitled one, or one that isn't JSON", async () => {
    for (const body of [assignmentView("asg_other", "Someone else's"), assignmentView(ASSIGNMENT, "  "), "not json"]) {
      const district: DistrictApiBinding = {
        fetch: (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 })) as Fetcher["fetch"],
      };
      expect(await resolveSchoolContext(district, JWT, `assignment:${ASSIGNMENT}`)).toEqual({ status: "refused" });
    }
  });

  it("refuses when the district can't be reached", async () => {
    const district: DistrictApiBinding = {
      fetch: (async () => { throw new Error("connection reset"); }) as Fetcher["fetch"],
    };
    expect(await resolveSchoolContext(district, JWT, `assignment:${ASSIGNMENT}`)).toEqual({ status: "refused" });
  });
});
