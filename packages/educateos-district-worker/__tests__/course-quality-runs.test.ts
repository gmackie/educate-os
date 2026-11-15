// Real Cloudflare workerd SQLite tests for immutable Curriculum CI history.
// Synthetic report metadata only: never student records, lesson bodies or answer keys.
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableObjectCourseQualityRunStore, DISTRICT_TABLES } from "@educateos/district-app/durable-stores";
import { CourseQualityRunBody } from "@educateos/district-app/routes";

let count = 0;
const fresh = () => env.DISTRICT.getByName("quality-history-" + count++);
const hex = (c: string) => "sha256:" + c.repeat(64);
const CHECKS = [
  "package-integrity", "publisher-trust", "standards", "activity-portability", "resource-portability",
  "reading-attribution", "instructor-material", "copyright-rights", "accessibility", "educational-effectiveness",
] as const;

function run(id = "cqr_" + "a".repeat(32), key = "quality-history-test-1") {
  return CourseQualityRunBody.parse({
    id,
    offeringId: "off_nf-eng9-fall-p3",
    requestedBy: "prn_nf-teacher-rivera",
    requestKey: key,
    createdAt: "2026-11-15T17:00:00Z",
    checkVersion: "curriculum-preflight-v0.1",
    reportFingerprint: hex("f"),
    context: { standardsDecisionDigest: hex("a"), districtSettingsDigest: hex("b") },
    report: {
      packageId: "educateos.io/grade-1-reading-foundations",
      version: "1.0.0",
      digest: hex("c"),
      title: "Synthetic course",
      publicationApproved: false,
      readOnly: true,
      summary: { passed: 1, attention: 0, notVerified: 9 },
      checks: CHECKS.map((id, index) => ({
        id, status: index === 0 ? "pass" : "not-verified",
        explanation: "Synthetic check without real learner information.",
        deterministic: index === 0,
      })),
    },
    historicalOnly: true,
  });
}

describe("CourseQualityRunStore (real Durable Object SQLite)", () => {
  it("persists immutable history across a restart, scopes reads, and refuses direct UPDATE/DELETE", async () => {
    const obj = fresh();
    const saved = run();
    await runInDurableObject(obj, async (_instance, state) => {
      const store = new DurableObjectCourseQualityRunStore(state.storage);
      expect(await store.append(saved)).toStrictEqual(saved);
      expect(await store.append(saved)).toStrictEqual(saved);
      expect(await store.list(saved.offeringId)).toStrictEqual([saved]);
      expect(await store.get("off_other-offering", saved.id)).toBeUndefined();
      const table = DISTRICT_TABLES.courseQualityRuns;
      expect(() => state.storage.sql.exec(
        "UPDATE " + table + " SET run_json = ? WHERE id = ?", "{}", saved.id,
      )).toThrow(/immutable/);
      expect(() => state.storage.sql.exec(
        "DELETE FROM " + table + " WHERE id = ?", saved.id,
      )).toThrow(/immutable/);
    });
    await evictDurableObject(obj);
    await runInDurableObject(obj, async (_instance, state) => {
      const store = new DurableObjectCourseQualityRunStore(state.storage);
      expect(await store.get(saved.offeringId, saved.id)).toStrictEqual(saved);
      const next = run("cqr_" + "b".repeat(32), "quality-history-test-2");
      await store.append(next);
      expect(await store.list(saved.offeringId)).toStrictEqual([next, saved]);
      expect(await store.get("off_other-offering", saved.id)).toBeUndefined();
    });
  });

  it("rejects idempotency misuse, duplicate run IDs and malformed stored rows", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectCourseQualityRunStore(state.storage);
      const first = run();
      await store.append(first);
      await expect(store.append({
        ...first, context: { ...first.context, standardsDecisionDigest: hex("d") },
      })).rejects.toMatchObject({ code: "conflict" });
      await expect(store.append({ ...first, requestKey: "quality-history-test-2" }))
        .rejects.toThrow();
      const table = DISTRICT_TABLES.courseQualityRuns;
      state.storage.sql.exec(
        "INSERT INTO " + table + " (id, offering_id, requested_by, request_key, run_json) VALUES (?, ?, ?, ?, ?)",
        "cqr_" + "e".repeat(32), first.offeringId, first.requestedBy, "quality-history-corrupt", "{}",
      );
      await expect(store.get(first.offeringId, "cqr_" + "e".repeat(32))).rejects.toThrow(/schema/);
      expect(await store.get(first.offeringId, first.id)).toStrictEqual(first);
    });
  });
});
