import { describe, expect, it } from "vitest";
import { EnrollmentId, OfferingId, PrincipalId, TermId, type AuthorityMap, type Caller, type DistrictDirectorySnapshot } from "@educateos/contracts";
import { InMemoryAcademicStore } from "@educateos/academics";
import { NORTHFIELD } from "@educateos/fixtures";
import { createAcademicsWithPolicy, InMemoryPolicyAuditSink } from "../src/index.ts";
import { P, SHARING_FLOOR } from "./setup.ts";

const ALL_LOCAL: AuthorityMap = {
  school: "local",
  term: "local",
  course: "local",
  offering: "local",
  enrollment: "local",
  principal: "local",
};

function academics(snapshot: DistrictDirectorySnapshot = NORTHFIELD) {
  const store = InMemoryAcademicStore.seeded(snapshot);
  const audit = new InMemoryPolicyAuditSink();
  const built = createAcademicsWithPolicy({
    store,
    authority: ALL_LOCAL,
    policy: { effectivePolicy: async () => SHARING_FLOOR },
    audit,
  });
  return { ...built, store, audit };
}

const http = (principal: Caller["principal"]): Caller => ({ principal, channel: "http" });
const mcp = (principal: Caller["principal"]) => ({ principal, channel: "mcp-tool" as const });

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("the academic directory with the policy engine", () => {
  it("lets students and teachers read terms, catalog courses and the offerings they are in", async () => {
    const { directory } = academics();
    expect((await directory.listTerms(http(P.amara))).map((t) => t.id)).toEqual(["trm_nf-2026-spring", "trm_nf-2026-fall"]);
    expect(await directory.listCourses(http(P.chidi))).toHaveLength(4);
    expect((await directory.listOfferings(http(P.amara))).map((o) => o.id).toSorted()).toEqual([
      "off_nf-bio-fall-p2",
      "off_nf-bio-spring-p4",
      "off_nf-eng9-fall-p3",
    ]);
    expect((await directory.listOfferings(http(P.chen))).map((o) => o.id).toSorted()).toEqual(["off_nf-eng9-fall-p3", "off_nf-ushist-fall-p5"]);
    await rejectsWith(directory.getOffering(http(P.chidi), OfferingId.parse("off_nf-bio-fall-p2")), "not-found");
  });

  it("keeps rosters from students and gives them to the offering's staff", async () => {
    const { directory } = academics();
    expect(await directory.roster(http(P.morgan), OfferingId.parse("off_nf-bio-fall-p2"))).toHaveLength(4);
    await rejectsWith(directory.roster(http(P.amara), OfferingId.parse("off_nf-bio-fall-p2")), "forbidden");
    await rejectsWith(directory.roster(http(P.chidi), OfferingId.parse("off_nf-bio-fall-p2")), "not-found");
  });

  it("ends a teacher's roster access when their enrollment is deactivated, despite the roster role assignment", async () => {
    const { directory } = academics();
    const eng9 = OfferingId.parse("off_nf-eng9-fall-p3");
    expect(await directory.roster(http(P.rivera), eng9)).toHaveLength(4);
    await directory.deactivateEnrollment(http(P.nfAdmin), EnrollmentId.parse("enr_nf-07"));
    await rejectsWith(directory.roster(http(P.rivera), eng9), "not-found");
  });

  it("treats a completed term's enrollments as read-only, even for the district admin", async () => {
    const { directory } = academics();
    await rejectsWith(directory.deactivateEnrollment(http(P.nfAdmin), EnrollmentId.parse("enr_nf-06")), "forbidden");
    expect(await directory.getEnrollment(http(P.amara), EnrollmentId.parse("enr_nf-06"))).toMatchObject({ status: "active" });
  });

  it("denies a Riverbend admin, and audits each denial as a cross-district precheck (SCHO-54)", async () => {
    const { directory, audit } = academics();
    expect(await directory.listSchools(http(P.rbAdmin))).toEqual([]);
    await rejectsWith(directory.getTerm(http(P.rbAdmin), TermId.parse("trm_nf-2026-fall")), "not-found");
    expect(audit.events.length).toBeGreaterThan(0);
    expect(audit.events.every((e) => e.ruleId === "precheck.cross-district" && e.reason === "cross-district" && e.principalId === P.rbAdmin.principalId))
      .toBe(true);
  });

  it("audits a request too malformed to authorize as an invalid-request precheck", async () => {
    const { directory, audit } = academics();
    const malformed = { principal: { ...P.amara, principalId: "not a principal" }, channel: "http" } as unknown as Caller;
    await rejectsWith(directory.getTerm(malformed, TermId.parse("trm_nf-2026-fall")), "not-found");
    expect(audit.events).toMatchObject([{ effect: "deny", reason: "invalid-request", ruleId: "precheck.invalid-request", action: "read", resourceKind: "term" }]);
    expect(audit.events[0]!.principalId).toBeUndefined();
  });

  it("audits every decision of one call under the caller's correlation ID", async () => {
    const { directory, audit } = academics();
    await directory.listSchools({ ...http(P.highPrincipal), correlationId: "corr-listing-1" });
    expect(audit.events.map((e) => e.correlationId)).toEqual(["corr-listing-1", "corr-listing-1"]);
  });

  it("audits each decision it is asked for with the deciding rule", async () => {
    const { directory, audit } = academics();
    await directory.listSchools(http(P.highPrincipal));
    expect(audit.events.map((e) => [e.resourceId, e.effect, e.ruleId])).toEqual([
      ["sch_nf-high", "allow", "admin.school.directory"],
      ["sch_nf-middle", "deny", "default.deny"],
    ]);
  });
});

describe("the academic tools through the school tool runner", () => {
  it("offers only operations exposed to agents, so create_principal is no tool (SCHO-173)", async () => {
    const { tools, store } = academics();
    const names = tools.list().map((t) => t.name);
    expect(names).toContain("update_principal");
    expect(names).not.toContain("create_principal");
    const before = (await store.load()).snapshot;
    const input = { kind: "student", displayName: "Robin", identity: { issuer: NORTHFIELD.district.trustedIssuers[0]!, subject: "robin" } };
    expect(await tools.invoke(mcp(P.nfAdmin), "create_principal", input)).toMatchObject({ status: "error", error: { code: "not-found", message: "There is no such tool." } });
    expect((await store.load()).snapshot).toEqual(before);
  });

  it("treats a principal named in the input only as a selector", async () => {
    const { tools } = academics();
    const others = await tools.invoke(mcp(P.amara), "list_enrollments", { principalId: "prn_nf-student-elena" });
    expect(others).toMatchObject({ status: "ok", value: [] });
    const mine = await tools.invoke(mcp(P.amara), "my_enrollments", {});
    expect(mine.status).toBe("ok");
    if (mine.status === "ok") {
      expect((mine.value as { principalId: string }[]).every((e) => e.principalId === P.amara.principalId)).toBe(true);
    }
  });

  it("rejects an identity smuggled into a tool's arguments", async () => {
    const { tools } = academics();
    const outcome = await tools.invoke(mcp(P.amara), "my_enrollments", { principalId: "prn_nf-student-elena" });
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation-failed" } });
  });

  it("refuses a principal from another district before the operation runs", async () => {
    const { tools, audit } = academics();
    const outcome = await tools.invoke(mcp(P.rbAdmin), "list_schools", {});
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(audit.events.every((e) => e.ruleId === "precheck.cross-district")).toBe(true);
  });

  it("passes operation errors through with the invocation's correlation ID", async () => {
    const { tools, audit } = academics();
    const outcome = await tools.invoke(mcp(P.amara), "get_roster", { offeringId: "off_nf-math7-fall-p1" });
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found", correlationId: expect.any(String) } });
    expect(audit.events[0]).toMatchObject({ action: "invoke-tool", ruleId: "tool.invoke.district-member", effect: "allow" });
  });

  it("audits the runner's decision and the operation's own under the invocation's one correlation ID", async () => {
    const { tools, audit } = academics();
    const outcome = await tools.invoke(mcp(P.highPrincipal), "list_schools", {});
    expect(outcome).toMatchObject({ status: "ok", correlationId: expect.any(String) });
    expect(audit.events.map((e) => e.ruleId)).toEqual(["tool.invoke.district-member", "admin.school.directory", "default.deny"]);
    expect(new Set(audit.events.map((e) => e.correlationId))).toEqual(new Set([outcome.status === "ok" ? outcome.correlationId : ""]));
  });

  it("lets an admin create through a tool and records the operation's own decision", async () => {
    const { tools, audit } = academics();
    const outcome = await tools.invoke(mcp(P.nfAdmin), "create_enrollment", {
      offeringId: "off_nf-math7-fall-p1",
      principalId: PrincipalId.parse("prn_nf-student-felix"),
      role: "student",
    });
    // Felix is already actively enrolled there.
    expect(outcome).toMatchObject({ status: "error", error: { code: "conflict" } });
    expect(audit.events.map((e) => e.ruleId)).toEqual(["tool.invoke.district-member", "admin.district.directory"]);
  });
});

describe("academic school tools and the approval transaction (SCHO-175)", () => {
  it("carry each operation's approval policy, and name a write's source of record only to an authorized caller", async () => {
    const store = InMemoryAcademicStore.seeded(NORTHFIELD);
    const roster: AuthorityMap = { ...ALL_LOCAL, enrollment: "external:oneroster" };
    const { tools, directory } = createAcademicsWithPolicy({ store, authority: roster, policy: { effectivePolicy: async () => SHARING_FLOOR }, audit: new InMemoryPolicyAuditSink() });
    // The tools' recheck routes by the directory's own bindings.
    expect(() => directory.assertRoutableWrite("create_enrollment", "enrollment")).toThrow("owned by external:oneroster");
    expect(() => directory.assertRoutableWrite("create_school", "school")).not.toThrow();
    const enrol = { offeringId: "off_nf-bio-fall-p2", principalId: "prn_nf-student-chidi", role: "student" };
    expect(await tools.invoke(mcp(P.nfAdmin), "create_enrollment", enrol)).toMatchObject({
      status: "error",
      error: { code: "conflict", message: "Enrollments are owned by external:oneroster; change them there and let its sync update EducateOS." },
    });
    // A same-district student may invoke tools, but not enrol anyone: the owner is not named to them.
    const student = await tools.invoke(mcp(P.amara), "create_enrollment", enrol);
    expect(student).toMatchObject({ status: "error", error: { code: expect.stringMatching(/^(forbidden|not-found)$/) } });
    expect(JSON.stringify(student)).not.toContain("oneroster");
    // A read is never rechecked: it answers from EducateOS's projection.
    expect(await tools.invoke(mcp(P.nfAdmin), "get_roster", { offeringId: "off_nf-bio-fall-p2" })).toMatchObject({ status: "ok" });
  });
});
