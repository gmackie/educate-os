// District-owned immutable snapshots of curriculum-quality metadata (not grades or approvals).
import { describe, expect, it } from "vitest";
import { PublisherTrust } from "../src/index.ts";
import bundle from "../../../curriculum/bundles/educateos.io/grade-1-reading-foundations/1.0.0.json" with { type: "json" };
import publisher from "../../../curriculum/educateos.io/publisher.json" with { type: "json" };
import { bootDistrict, expectError, NF } from "./support.ts";

const TRUST = PublisherTrust.parse({ localDomains: [], publishers: [publisher] });
const COURSE = { packageId: "educateos.io/grade-1-reading-foundations", version: "1.0.0" } as const;
const params = { offeringId: NF.eng9 };
const request = { ...COURSE, idempotencyKey: "curriculum-quality-run-test-1" };

async function setup() {
  const district = await bootDistrict(undefined, { courseLibraryTrust: TRUST });
  const admin = district.tokenFor(NF.admin);
  const teacher = district.tokenFor(NF.rivera);
  await district.ok(admin, "admin.importCourseBundle", { body: structuredClone(bundle) as never });
  return { district, teacher };
}

describe("immutable, teacher-scoped Curriculum CI runs", () => {
  it("pins checks to a course digest, evaluator version and district evaluation context", async () => {
    const { district, teacher } = await setup();
    const before = await district.ok(teacher, "teacher.listModules", { params });
    const installs = await district.stores.courseLibrary.loadInstalls(params.offeringId);
    const run = await district.ok(teacher, "teacher.runCurriculumQuality", { params, body: request });
    expect(run).toMatchObject({
      offeringId: params.offeringId, checkVersion: "curriculum-preflight-v0.1",
      historicalOnly: true,
      report: { ...COURSE, publicationApproved: false, readOnly: true },
    });
    expect(run.id).toMatch(/^cqr_[0-9a-f]{32}$/);
    expect(run.reportFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.context.standardsDecisionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.context.districtSettingsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.report.checks).toHaveLength(10);
    const again = await district.ok(teacher, "teacher.runCurriculumQuality", { params, body: request });
    expect(again).toStrictEqual(run);
    expect(await district.ok(teacher, "teacher.listCurriculumQualityRuns", { params })).toStrictEqual([run]);
    expect(await district.ok(teacher, "teacher.getCurriculumQualityRun", {
      params: { ...params, runId: run.id },
    })).toStrictEqual(run);
    const next = await district.ok(teacher, "teacher.runCurriculumQuality", {
      params, body: { ...request, idempotencyKey: "curriculum-quality-run-test-2" },
    });
    expect(next.id).not.toBe(run.id);
    expect((await district.ok(teacher, "teacher.listCurriculumQualityRuns", { params })).map((r) => r.id))
      .toStrictEqual([next.id, run.id]);
    expect(await district.ok(teacher, "teacher.listModules", { params })).toStrictEqual(before);
    expect(await district.stores.courseLibrary.loadInstalls(params.offeringId)).toStrictEqual(installs);
    expect(JSON.stringify(run)).not.toContain("Amara");
  });

  it("rejects reused idempotency keys with changed course or standards evaluation", async () => {
    const { district, teacher } = await setup();
    const run = await district.ok(teacher, "teacher.runCurriculumQuality", { params, body: request });
    const altered = {
      ...run,
      context: { ...run.context, standardsDecisionDigest: "sha256:" + "f".repeat(64) },
    };
    await expect(district.stores.courseQualityRuns.append(altered)).rejects.toMatchObject({ code: "conflict" });
    const wrongCourse = { ...run, report: { ...run.report, version: "9.9.9" } };
    await expect(district.stores.courseQualityRuns.append(wrongCourse)).rejects.toMatchObject({ code: "conflict" });
    expect(await district.ok(teacher, "teacher.listCurriculumQualityRuns", { params })).toStrictEqual([run]);
  });

  it("enforces per-offering teacher roles before revealing stored report existence", async () => {
    const { district, teacher } = await setup();
    const student = district.tokenFor(NF.amara);
    const run = await district.ok(teacher, "teacher.runCurriculumQuality", { params, body: request });
    for (const token of [student, undefined]) {
      expectError(await district.call(token, "teacher.listCurriculumQualityRuns", { params }), token ? 403 : 401, token ? "forbidden" : "unauthenticated");
      expectError(await district.call(token, "teacher.runCurriculumQuality", { params, body: request }), token ? 403 : 401, token ? "forbidden" : "unauthenticated");
      expectError(await district.call(token, "teacher.getCurriculumQualityRun", {
        params: { ...params, runId: run.id },
      }), token ? 403 : 401, token ? "forbidden" : "unauthenticated");
    }
    expectError(await district.call(teacher, "teacher.getCurriculumQualityRun", {
      params: { ...params, runId: "cqr_" + "0".repeat(32) },
    }), 404, "not-found");
  });
});
