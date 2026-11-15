import { describe, expect, it } from "vitest";
import { usdNanoFromCents } from "@educateos/ai-governance";
import type { CourseIntentProvider } from "../src/index.ts";
import { PublisherTrust } from "../src/index.ts";
import bundle from "../../../curriculum/bundles/educateos.io/grade-1-reading-foundations/1.0.0.json" with { type: "json" };
import publisher from "../../../curriculum/educateos.io/publisher.json" with { type: "json" };
import { bootDistrict, expectError, NF } from "./support.ts";

const TRUST = PublisherTrust.parse({ localDomains: [], publishers: [publisher] });
const COURSE = { packageId: "educateos.io/grade-1-reading-foundations", version: "1.0.0" } as const;
const params = { offeringId: NF.eng9 };
let calls = 0;

const provider: CourseIntentProvider = {
  model: { provider: "cloudflare", modelId: "synthetic-model" },
  estimatedMaxUsdNano: usdNanoFromCents(5),
  async generate(input) {
    calls++;
    return {
      intent: {
        profile: "educateos.pedagogical-intent/0.1",
        id: "phonics-suggestion", revision: "0.1.0",
        source: input.source, origin: "machine-suggestion",
        learningGoals: [
          { id: "hear-short-vowels", statement: "Distinguish short vowels.", alignments: [] },
          { id: "explain-letter-sounds", statement: "Explain letter sounds.", alignments: [] },
        ],
        prerequisites: [], misconceptions: [],
        strategies: [
          { id: "paper-letters", approach: "Arrange paper letter cards.", conditions: [] },
          { id: "draw-vowels", approach: "Draw vowel shapes.", conditions: [] },
        ],
        expectedDemonstrations: [
          { id: "demonstrate-vowels", goalId: "hear-short-vowels", observable: "Say a short vowel.", modality: "explain" },
        ],
      },
      usage: { inputTokens: 80, outputTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0 },
      actualUsdNano: usdNanoFromCents(1),
    };
  },
};

async function setup(custom: CourseIntentProvider = provider) {
  const district = await bootDistrict(undefined, { courseLibraryTrust: TRUST, courseIntentProvider: custom });
  const teacher = district.tokenFor(NF.rivera);
  const admin = district.tokenFor(NF.admin);
  await district.ok(admin, "admin.importCourseBundle", { body: structuredClone(bundle) as never });
  const preview = await district.ok(teacher, "teacher.previewCourseInstall", { params, body: COURSE });
  return { district, teacher, unitKey: preview.units[0]!.key };
}

describe("teacher-owned private course adaptation drafts", () => {
  it("claims requests before inference, replays identical keys and saves teacher-selected notes", async () => {
    calls = 0;
    const { district, teacher, unitKey } = await setup();
    const original = await district.ok(teacher, "teacher.listModules", { params });
    const input = { ...COURSE, unitKey, goal: "low-equipment" as const, requestKey: "same-teacher-request-001" };
    const draft = await district.ok(teacher, "teacher.suggestCourseIntent", { params, body: input });
    expect(draft).toMatchObject({ status: "proposed", revision: 2, draftOnly: true });
    expect(draft.draftId).toMatch(/^cid_[0-9a-f]{32}$/);
    expect(calls).toBe(1);
    const replay = await district.ok(teacher, "teacher.suggestCourseIntent", { params, body: input });
    expect(replay).toStrictEqual(draft);
    expect(calls).toBe(1);
    const listed = await district.ok(teacher, "teacher.listCourseIntentDrafts", { params });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: draft.draftId, status: "proposed", revision: 2 });
    expect(await district.ok(teacher, "teacher.getCourseIntentDraft", {
      params: { ...params, draftId: draft.draftId },
    })).toStrictEqual(listed[0]);

    const reviewed = await district.ok(teacher, "teacher.reviewCourseIntentDraft", {
      params: { ...params, draftId: draft.draftId },
      body: { action: "review", expectedRevision: 2,
        selection: { goalIds: ["hear-short-vowels"], strategyIds: ["paper-letters"] } },
    });
    expect(reviewed).toMatchObject({
      revision: 3, status: "reviewed",
      selection: { goalIds: ["hear-short-vowels"], strategyIds: ["paper-letters"] },
    });
    const history = await district.stores.courseIntentDrafts.history(params.offeringId, NF.rivera, draft.draftId);
    expect(history.map((v) => [v.revision, v.status])).toStrictEqual([
      [1, "pending"], [2, "proposed"], [3, "reviewed"],
    ]);
    const afterReviewReplay = await district.ok(teacher, "teacher.suggestCourseIntent", { params, body: input });
    expect(afterReviewReplay.status).toBe("reviewed");
    expect(calls).toBe(1);
    expect(await district.ok(teacher, "teacher.listModules", { params })).toStrictEqual(original);
    expect(JSON.stringify(reviewed)).not.toContain("Amara");
  });

  it("rejects invalid selections, stale revisions and student access", async () => {
    calls = 0;
    const { district, teacher, unitKey } = await setup();
    const student = district.tokenFor(NF.amara);
    const request = { ...COURSE, unitKey, goal: "accessibility-first" as const, requestKey: "teacher-request-002" };
    const draft = await district.ok(teacher, "teacher.suggestCourseIntent", { params, body: request });
    const p = { ...params, draftId: draft.draftId };
    expectError(await district.call(teacher, "teacher.reviewCourseIntentDraft", {
      params: p, body: { action: "review", expectedRevision: 2,
        selection: { goalIds: ["not-in-source"], strategyIds: ["paper-letters"] } },
    }), 400, "validation-failed");
    expectError(await district.call(student, "teacher.listCourseIntentDrafts", { params }), 403, "forbidden");
    expectError(await district.call(student, "teacher.getCourseIntentDraft", { params: p }), 403, "forbidden");
    expectError(await district.call(student, "teacher.reviewCourseIntentDraft", {
      params: p, body: { action: "discard", expectedRevision: 2 },
    }), 403, "forbidden");

    const discarded = await district.ok(teacher, "teacher.reviewCourseIntentDraft", {
      params: p, body: { action: "discard", expectedRevision: 2 },
    });
    expect(discarded.status).toBe("discarded");
    expect(discarded.result).toBeUndefined();
    expectError(await district.call(teacher, "teacher.reviewCourseIntentDraft", {
      params: p, body: { action: "review", expectedRevision: 2,
        selection: { goalIds: ["hear-short-vowels"], strategyIds: [] } },
    }), 409, "conflict");
    // A discarded request key never causes another provider call.
    expectError(await district.call(teacher, "teacher.suggestCourseIntent", {
      params, body: request,
    }), 409, "conflict");
    expect(calls).toBe(1);
  });

  it("records failed model attempts without automatic retry or double spending", async () => {
    calls = 0;
    const failing: CourseIntentProvider = { ...provider, async generate() {
      calls++;
      throw new Error("Synthetic provider failure; could have charged a request.");
    } };
    const { district, teacher, unitKey } = await setup(failing);
    const request = { ...COURSE, unitKey, goal: "hands-on-practice" as const, requestKey: "failed-model-request-003" };
    expectError(await district.call(teacher, "teacher.suggestCourseIntent", {
      params, body: request,
    }), 503, "unavailable");
    const saved = await district.ok(teacher, "teacher.listCourseIntentDrafts", { params });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.status).toBe("failed");
    expect(saved[0]!.result).toBeUndefined();
    expectError(await district.call(teacher, "teacher.suggestCourseIntent", {
      params, body: request,
    }), 409, "conflict");
    expect(calls).toBe(1);
  });
});
