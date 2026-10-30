import { expect, it } from "vitest";
import { AcademicDirectory, InMemoryAcademicStore } from "@educateos/academics";
import { NORTHFIELD } from "@educateos/fixtures";
import { authorityFor } from "@educateos/district-app";
import { PolicyEngine, directoryPolicyInformation, InMemoryPolicyAuditSink, SchoolToolRunner, InMemoryToolApprovalStore } from "@educateos/policy";
import { externalOperationAction, externalSchoolTools } from "../src/registry.ts";
import type { PolicySettings } from "@educateos/contracts";
const floor: PolicySettings = { aiSpending: "capped", promptsInGatewayLogs: "prohibited", studentPersonalConversations: "shared-by-student", teacherObservation: "assigned-work-and-shared-conversations", automatedSelProfiling: "prohibited", aiMonthlyCapCentsPerPrincipal: 500 };
function setup() {
  const store = InMemoryAcademicStore.seeded(NORTHFIELD);
  const engine = new PolicyEngine({ information: directoryPolicyInformation(store, { effectivePolicy: async () => floor }), audit: new InMemoryPolicyAuditSink() });
  const directory = new AcademicDirectory({ store, authority: authorityFor("local"), authorizer: engine });
  const definitions = externalSchoolTools(store, directory);
  // Misleading annotations deliberately attached to real trusted definitions.
  const runner = new SchoolToolRunner({ engine, tools: definitions.map((t) => ({ ...t, annotations: { readOnlyHint: true } })), approvals: { store: new InMemoryToolApprovalStore() } });
  const session = (id: string) => ({ principal: { principalId: NORTHFIELD.principals.find((p) => p.id === id)!.id, districtId: NORTHFIELD.district.id }, channel: "mcp-tool" as const });
  return { engine, store, definitions, runner, session };
}
it("returns permitted course evidence immediately under a trusted read action", async () => {
  const w = setup();
  const course = NORTHFIELD.courses[0]!;
  const result = await w.runner.invoke(w.session("prn_nf-morgan-lee"), "get_course", { courseId: course.id }, { confirmWrites: true });
  expect(result).toMatchObject({ status: "ok", value: { id: course.id } });
  expect(w.definitions.find((t) => t.name === "get_course")?.action).toBe("read");
  expect(w.definitions.find((t) => t.name === "list_courses")?.action).toBe("list");
  expect(await w.runner.invoke(w.session("prn_nf-morgan-lee"), "list_courses", {}, { confirmWrites: true })).toMatchObject({ status: "ok" });
});
it("denies a classmate enrollment read and cross-school roster without returning evidence", async () => {
  const w = setup();
  const classmate = NORTHFIELD.enrollments.find((e) => e.principalId === "prn_nf-student-amara")!;
  expect(await w.runner.invoke(w.session("prn_nf-student-elena"), "get_enrollment", { enrollmentId: classmate.id }, { confirmWrites: true })).toMatchObject({ status: "error", error: { code: "not-found" } });
  expect(await w.runner.invoke(w.session("prn_nf-student-chidi"), "get_roster", { offeringId: "off_nf-bio-fall-p2" }, { confirmWrites: true })).toMatchObject({ status: "error" });
});
it("queues a true write despite readOnlyHint and rejects body metadata elevation", async () => {
  const w = setup();
  const admin = NORTHFIELD.roleAssignments.find((r) => r.role === "district-admin")!.principalId;
  const course = NORTHFIELD.courses[0]!;
  const input = { courseId: course.id, title: "Synthetic proposed title" };
  expect(await w.runner.invoke(w.session(admin), "update_course", input, { confirmWrites: true })).toMatchObject({ status: "approval-required" });
  expect((await w.store.load()).snapshot.courses[0]).toEqual(course);
  for (const metadata of [{ readOnlyHint: true }, { readOnly: true }, { action: "read" }, { role: "teacher" }]) {
    expect(await w.runner.invoke(w.session(admin), "update_course", { ...input, ...metadata }, { confirmWrites: true })).toMatchObject({ status: "error", error: { code: "validation-failed" } });
  }
  expect(externalOperationAction("unknown_safe_read")).toBe("invoke-tool");
  expect(externalOperationAction("toString")).toBe("invoke-tool");
});

it("queues an unclassified server tool even when its display metadata claims a safe read", async () => {
  const w = setup();
  let ran = false;
  const tool = w.definitions.find((t) => t.name === "list_courses")!;
  const runner = new SchoolToolRunner({ engine: w.engine, approvals: { store: new InMemoryToolApprovalStore() }, tools: [{
    ...tool, name: "unknown_safe_read", action: externalOperationAction("unknown_safe_read"), annotations: { readOnlyHint: true },
    resource: async () => ({ resource: { kind: "district", classification: "district-internal", scope: { level: "district", districtId: NORTHFIELD.district.id } } }),
    handler: async () => { ran = true; return "must wait"; },
  }] });
  expect(await runner.invoke(w.session("prn_nf-morgan-lee"), "unknown_safe_read", {}, { confirmWrites: true })).toMatchObject({ status: "approval-required" });
  expect(ran).toBe(false);
});
