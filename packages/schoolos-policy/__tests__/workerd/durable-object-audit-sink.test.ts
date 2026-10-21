// `DurableObjectPolicyAuditSink` in workerd, against real Durable Object SQLite storage: decisions,
// denials included, survive a restart and are found by the correlation ID an error body carries;
// history cannot be rewritten; and nothing but a content-free event is ever stored.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { NORTHFIELD } from "@schoolos/fixtures";
import { directoryPolicyInformation, PolicyEngine, type PolicyAuditEvent } from "../../src/index.ts";
import {
  DurableObjectPolicyAuditSink,
  POLICY_AUDIT_TABLE,
  PolicyAuditCorruptionError,
} from "../../src/durable-object-audit-sink.ts";

let trails = 0;
const fresh = () => env.AUDIT.getByName(`trail-${trails++}`);

const ADMIN = { principalId: "prn_nf-district-admin", districtId: "dst_northfield" };
const RB_ADMIN = { principalId: "prn_rb-district-admin", districtId: "dst_riverbend" };
const termsOf = (districtId: string) => ({
  kind: "term",
  scope: { level: "district", districtId },
  classification: "district-internal",
});

/** An engine over Northfield that records every decision in `trail`, as a district Worker would. */
function engineRecordingTo(trail: ReturnType<typeof fresh>) {
  return new PolicyEngine({
    information: directoryPolicyInformation(InMemoryAcademicStore.seeded(NORTHFIELD), {
      effectivePolicy: async () => ({
        aiSpending: "capped",
        promptsInGatewayLogs: "prohibited",
        studentPersonalConversations: "private",
        teacherObservation: "assigned-work-only",
        automatedSelProfiling: "prohibited",
        aiMonthlyCapCentsPerPrincipal: 500,
      }),
    }),
    audit: { record: (event) => trail.record(event) },
  });
}

const event = (correlationId: string): PolicyAuditEvent => ({
  correlationId,
  decidedAt: "2026-10-21T10:00:00.000Z",
  principalId: ADMIN.principalId as PolicyAuditEvent["principalId"],
  effect: "allow",
  ruleId: "admin.district.directory",
});

describe("DurableObjectPolicyAuditSink", () => {
  it("keeps a cross-district denial across a restart, under the correlation ID its caller was given", async () => {
    const trail = fresh();
    const engine = engineRecordingTo(trail);
    const denied = await engine.decide({ subject: RB_ADMIN, action: "create", resource: termsOf("dst_northfield"), context: { channel: "http" } }, { correlationId: "cor-denied" });
    const allowed = await engine.decide({ subject: ADMIN, action: "create", resource: termsOf("dst_northfield"), context: { channel: "http" } }, { correlationId: "cor-allowed" });
    expect(denied.decision).toStrictEqual({ effect: "deny", reason: "cross-district" });
    expect(allowed.decision).toStrictEqual({ effect: "allow" });

    await evictDurableObject(trail);
    expect(await trail.forCorrelation("cor-denied")).toStrictEqual([
      expect.objectContaining({ correlationId: "cor-denied", principalId: RB_ADMIN.principalId, effect: "deny", reason: "cross-district", ruleId: "precheck.cross-district" }),
    ]);
    const page = await trail.read(0, 10);
    expect(page.map((stored) => stored.event.correlationId)).toStrictEqual(["cor-denied", "cor-allowed"]);
    expect(page[1]!.seq).toBeGreaterThan(page[0]!.seq);
    // Paging resumes after the last position seen.
    expect((await trail.read(page[0]!.seq, 10)).map((stored) => stored.event.correlationId)).toStrictEqual(["cor-allowed"]);
  });

  it("refuses to rewrite or delete a recorded decision", async () => {
    const trail = fresh();
    await trail.record(event("cor-1"));
    await runInDurableObject(trail, (_instance, state) => {
      expect(() => state.storage.sql.exec(`UPDATE ${POLICY_AUDIT_TABLE} SET effect = 'deny'`)).toThrow(/append-only/);
      expect(() => state.storage.sql.exec(`DELETE FROM ${POLICY_AUDIT_TABLE}`)).toThrow(/append-only/);
    });
    expect(await trail.forCorrelation("cor-1")).toStrictEqual([event("cor-1")]);
  });

  it("stores nothing for an event that carries content or misses required fields", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const sink = new DurableObjectPolicyAuditSink(state.storage);
      const withContent = { ...event("cor-2"), prompt: "my essay about my family" } as PolicyAuditEvent;
      await expect(sink.record(withContent)).rejects.toThrow();
      await expect(sink.record({ ...event("cor-2"), correlationId: "" })).rejects.toThrow();
      expect(await sink.read({ limit: 10 })).toStrictEqual([]);
    });
  });

  it("refuses to read back a row that is not an event", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const sink = new DurableObjectPolicyAuditSink(state.storage);
      await sink.record(event("cor-3"));
      state.storage.sql.exec(
        `INSERT INTO ${POLICY_AUDIT_TABLE} (correlation_id, decided_at, effect, event_json) VALUES ('cor-3', 'x', 'allow', '{"prompt":"x"}')`,
      );
      await expect(sink.forCorrelation("cor-3")).rejects.toThrow(PolicyAuditCorruptionError);
    });
  });
});
