// Routes bound to academic operations (SCHO-173): REST and the agent channel run one handler and
// reach one policy verdict, because both go through the operation descriptor.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EducateOsErrorBody } from "@educateos/contracts";
import { ACADEMIC_OPERATIONS, AcademicDirectory, type AcademicOperationName } from "@educateos/academics";
import { academicSchoolTools, InMemoryToolApprovalStore, SchoolToolRunner } from "@educateos/policy";
import { authorityFor, ROUTES, type AuthoritySetting, type OperationRouteName, type RouteName, type RouteSpec } from "../src/index.ts";
import { bootDistrict, NF, NORTHFIELD, type TestDistrict } from "./support.ts";

const OPERATION_ROUTES = (Object.entries(ROUTES) as [RouteName, RouteSpec][]).filter(([, spec]) => spec.operation !== undefined);

/** The district's academic tools on the agent channel, composed as the district Worker composes them. */
function agentRunner(district: TestDistrict, authority: AuthoritySetting, approvals?: InMemoryToolApprovalStore) {
  const directory = new AcademicDirectory({ store: district.stores.directory, authority: authorityFor(authority), authorizer: district.app.engine, now });
  return new SchoolToolRunner({
    engine: district.app.engine,
    tools: academicSchoolTools(district.stores.directory, directory),
    ...(approvals === undefined ? {} : { approvals: { store: approvals } }),
  });
}

/** One clock for both districts, so the records each writes can be compared. */
const now = () => new Date("2026-10-01T12:00:00.000Z");
const boot = (authority: AuthoritySetting) => bootDistrict(NORTHFIELD, { authority, now });

const subject = (principalId: string) => ({ principalId, districtId: NORTHFIELD.district.id }) as never;

interface Case {
  name: string;
  caller: string;
  authority: AuthoritySetting;
  route: OperationRouteName;
  params?: Record<string, string>;
  body: Record<string, unknown>;
  /** What both channels answer: `ok` or the error code. */
  outcome: "ok" | EducateOsErrorBody["code"];
}

const COURSE = NORTHFIELD.courses[0]!.id;
const SCHOOL = NORTHFIELD.schools[0]!.id;

const CASES: Case[] = [
  { name: "admin creates a course", caller: NF.admin, authority: "local", route: "admin.createCourse", body: { title: "Astronomy", subject: "science", gradeBand: "9-12" }, outcome: "ok" },
  { name: "admin renames a course", caller: NF.admin, authority: "local", route: "admin.updateCourse", params: { courseId: COURSE }, body: { title: "Biology I" }, outcome: "ok" },
  { name: "admin archives an offering", caller: NF.admin, authority: "local", route: "admin.archiveOffering", params: { offeringId: NF.bio }, body: { archived: true }, outcome: "ok" },
  { name: "admin enrolls a student", caller: NF.admin, authority: "local", route: "admin.enroll", params: { offeringId: NF.bio }, body: { principalId: "prn_nf-student-felix", role: "student" }, outcome: "ok" },
  { name: "admin moves a term backwards", caller: NF.admin, authority: "local", route: "admin.transitionTerm", params: { termId: NF.spring }, body: { to: "active" }, outcome: "conflict" },
  // A teacher may not read the school's admin record, so the refusal does not reveal it.
  { name: "teacher renames a school", caller: NF.rivera, authority: "local", route: "admin.updateSchool", params: { schoolId: SCHOOL }, body: { name: "Renamed" }, outcome: "not-found" },
  { name: "teacher creates a term", caller: NF.rivera, authority: "local", route: "admin.createTerm", body: { name: "Summer", startsOn: "2027-06-01", endsOn: "2027-08-01" }, outcome: "forbidden" },
  { name: "admin enrolls into a roster-owned offering", caller: NF.admin, authority: "oneroster", route: "admin.enroll", params: { offeringId: NF.bio }, body: { principalId: "prn_nf-student-felix", role: "student" }, outcome: "conflict" },
];

/** A created record's ID is generated, so two districts' results agree on everything else. */
const withoutId = (value: unknown) => (typeof value === "object" && value !== null ? { ...value, id: undefined } : value);

describe("routes bound to academic operations", () => {
  it("cover the first migrated group, each declaring exactly its operation's input and output", () => {
    expect(OPERATION_ROUTES.map(([name]) => name).toSorted()).toEqual([
      "admin.archiveCourse", "admin.archiveOffering", "admin.createCourse", "admin.createOffering", "admin.createSchool",
      "admin.createTerm", "admin.enroll", "admin.transitionTerm", "admin.updateCourse", "admin.updateOffering",
      "admin.updateSchool", "admin.updateTerm",
    ]);
    for (const [name, spec] of OPERATION_ROUTES) {
      const operation = ACADEMIC_OPERATIONS[spec.operation as AcademicOperationName];
      const routeFields = [...Object.keys(spec.params?.shape ?? {}), ...Object.keys((spec.body as z.ZodObject).shape)];
      expect(routeFields.toSorted(), name).toEqual(Object.keys((operation.input as z.ZodObject).shape).toSorted());
      // A path parameter never also arrives in the body, where it could name another record.
      expect(new Set(routeFields).size, name).toBe(routeFields.length);
      // What the route says it answers is what the operation returns.
      expect(z.toJSONSchema(spec.response), name).toEqual(z.toJSONSchema(operation.output));
    }
  });

  it.each(CASES.map((c) => [c.name, c] as const))("run one handler with one verdict over REST and the agent channel: %s", async (_, c) => {
    const viaRest = await boot(c.authority);
    const viaAgent = await boot(c.authority);
    const operation = ROUTES[c.route].operation;

    const rest = await viaRest.call(viaRest.tokenFor(c.caller), c.route, { params: c.params, body: c.body } as never);
    const agent = await agentRunner(viaAgent, c.authority).invoke({ principal: subject(c.caller), channel: "agent" }, operation, { ...c.body, ...c.params });

    expect(agent.status === "ok" ? "ok" : (agent as { error: EducateOsErrorBody }).error.code).toBe(c.outcome);
    if (agent.status === "ok") {
      expect(rest.status).toBeLessThan(300);
      expect(withoutId(rest.body)).toEqual(withoutId(agent.value));
      expect(ACADEMIC_OPERATIONS[operation].output.safeParse(rest.body).success).toBe(true);
    } else {
      expect(agent.status).toBe("error");
      const { correlationId: _rest, ...restError } = EducateOsErrorBody.parse(rest.body);
      const { correlationId: _agent, ...agentError } = (agent as { error: EducateOsErrorBody }).error;
      expect(restError).toEqual(agentError);
    }
    // And they leave the two districts' records in the same state, apart from generated IDs.
    const records = async (district: TestDistrict) => {
      const { snapshot } = await district.stores.directory.load();
      return { ...snapshot, courses: snapshot.courses.map(withoutId), enrollments: snapshot.enrollments.map(withoutId) };
    };
    expect(await records(viaRest)).toEqual(await records(viaAgent));
  });

  it("name the owner when a write reaches a roster-owned record", async () => {
    const district = await boot("oneroster");
    const result = await district.call(district.tokenFor(NF.admin), "admin.enroll", {
      params: { offeringId: NF.bio }, body: { principalId: "prn_nf-student-felix", role: "student" },
    } as never);
    expect(result.status).toBe(409);
    expect(EducateOsErrorBody.parse(result.body).message).toMatch(/owned by external:oneroster/);
  });

  it("queue an agent's write for its requester, then apply the same change REST makes", async () => {
    const viaRest = await boot("local");
    const viaAgent = await boot("local");
    const runner = agentRunner(viaAgent, "local", new InMemoryToolApprovalStore());
    const input = { courseId: COURSE, title: "Biology I" };

    const queued = await runner.invoke({ principal: subject(NF.admin), channel: "agent" }, "update_course", input, { confirmWrites: true });
    expect(queued).toMatchObject({ status: "approval-required", needs: "confirmation" });
    const applied = await runner.approve({ principal: subject(NF.admin), channel: "http" }, (queued as { approvalId: string }).approvalId);
    const rest = await viaRest.ok(viaRest.tokenFor(NF.admin), "admin.updateCourse", { params: { courseId: COURSE }, body: { title: "Biology I" } });
    expect(applied).toMatchObject({ status: "applied", value: rest });
  });
});
