// SCHO-376: what an IT reviewer reads in the admin console. Only a district administrator, as a
// person, searches the decision trail (the safety decision log and the admin audit log) or reads the
// district's sign-in settings; nobody else, and never through an agent. Reading one decision to
// explain it (the policy simulator) stays the broader `admin.audit-read`.
import { describe, expect, it } from "vitest";
import { searchAuditEvents, type PolicyAuditEvent } from "../src/index.ts";
import { engineFor, P, req } from "./setup.ts";

const restricted = (kind: "audit-event" | "district", districtId = P.nfAdmin.districtId) =>
  ({ resource: { kind, scope: { level: "district", districtId }, classification: "restricted" } }) as const;

describe("the decision trail's search (SCHO-376)", () => {
  it("lets a district admin search it over HTTP", async () => {
    const { engine, audit } = engineFor();
    expect((await engine.decide(req(P.nfAdmin, "list", restricted("audit-event")))).decision.effect).toBe("allow");
    expect(audit.events.at(-1)?.ruleId).toBe("admin.district.audit-log");
  });

  it("refuses school admins, teachers, students, agents and other districts' admins", async () => {
    const { engine, audit } = engineFor();
    for (const who of [P.highPrincipal, P.morgan, P.rivera, P.amara]) {
      expect((await engine.decide(req(who, "list", restricted("audit-event")))).decision.effect, who.principalId).toBe("deny");
      expect(audit.events.at(-1)?.ruleId, who.principalId).toBe("admin.district.audit-log.others");
    }
    expect((await engine.decide(req(P.nfAdmin, "list", restricted("audit-event"), "agent"))).decision.effect).toBe("deny");
    expect(audit.events.at(-1)?.ruleId).toBe("admin.district.audit-log.others");
    expect((await engine.decide(req(P.rbAdmin, "list", restricted("audit-event")))).decision.effect).toBe("deny");
  });

  it("leaves explaining one decision to the administrators the simulator already allows", async () => {
    const { engine, audit } = engineFor();
    expect((await engine.decide(req(P.nfAdmin, "read", restricted("audit-event")))).decision.effect).toBe("allow");
    expect(audit.events.at(-1)?.ruleId).toBe("admin.audit-read");
  });
});

describe("the sign-in settings (SCHO-376)", () => {
  it("lets a district admin read them over HTTP", async () => {
    const { engine, audit } = engineFor();
    expect((await engine.decide(req(P.nfAdmin, "read", restricted("district")))).decision.effect).toBe("allow");
    expect(audit.events.at(-1)?.ruleId).toBe("admin.district.sign-in");
  });

  it("refuses school admins, teachers, students, agents and other districts' admins", async () => {
    const { engine } = engineFor();
    for (const who of [P.highPrincipal, P.morgan, P.rivera, P.amara, P.rbAdmin]) {
      expect((await engine.decide(req(who, "read", restricted("district")))).decision.effect, who.principalId).toBe("deny");
    }
    expect((await engine.decide(req(P.nfAdmin, "read", restricted("district"), "agent"))).decision.effect).toBe("deny");
  });

  it("does not change who reads the district's ordinary record", async () => {
    const { engine, audit } = engineFor();
    const ordinary = { resource: { kind: "district", scope: { level: "district", districtId: P.nfAdmin.districtId }, classification: "district-internal" } } as const;
    expect((await engine.decide(req(P.nfAdmin, "read", ordinary))).decision.effect).toBe("allow");
    expect(audit.events.at(-1)?.ruleId).toBe("admin.district.directory");
  });
});

describe("searchAuditEvents", () => {
  const at = (i: number, fields: Partial<PolicyAuditEvent> = {}): PolicyAuditEvent =>
    ({ correlationId: `cor-${i}`, decidedAt: "2026-11-01T10:00:00.000Z", effect: "allow", ruleId: "admin.district.directory", action: "update", ...fields });
  const trail = [
    at(1),
    at(2, { effect: "deny", reason: "no-matching-grant", ruleId: "default.deny", action: "read" }),
    at(3, { ruleId: "admin.governance", action: "configure" }),
    at(4, { ruleId: "course.instructor.read", action: "read" }),
    at(5, { ruleId: "admin.district.export", action: "export" }),
  ];
  const ids = (page: ReturnType<typeof searchAuditEvents>) => page.entries.map((e) => e.event.correlationId);

  it("finds the newest matches first and pages back through the rest", () => {
    const first = searchAuditEvents(trail, { limit: 2, rule: "admin." });
    expect(ids(first)).toStrictEqual(["cor-5", "cor-3"]);
    expect(first.entries.map((e) => e.seq)).toStrictEqual([5, 3]);
    const second = searchAuditEvents(trail, { limit: 2, rule: "admin.", before: first.nextBefore! });
    expect(ids(second)).toStrictEqual(["cor-1"]);
    expect(second.nextBefore).toBeUndefined();
  });

  it("filters by outcome, exact rule, action and subject", () => {
    expect(ids(searchAuditEvents(trail, { limit: 10, effects: ["deny", "require-approval"] }))).toStrictEqual(["cor-2"]);
    expect(ids(searchAuditEvents(trail, { limit: 10, rule: "admin.governance" }))).toStrictEqual(["cor-3"]);
    // A rule ID without its trailing dot is exact, not a prefix.
    expect(ids(searchAuditEvents(trail, { limit: 10, rule: "admin" }))).toStrictEqual([]);
    expect(ids(searchAuditEvents(trail, { limit: 10, actions: ["export", "configure"] }))).toStrictEqual(["cor-5", "cor-3"]);
    expect(ids(searchAuditEvents(trail, { limit: 10, principalId: P.nfAdmin.principalId }))).toStrictEqual([]);
  });

  it("refuses a page larger than a screen", () => {
    expect(() => searchAuditEvents(trail, { limit: 101 })).toThrow();
  });
});
