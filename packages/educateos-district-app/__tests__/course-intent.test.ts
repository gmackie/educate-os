// The model may propose a draft, but cannot access student data, grades, lesson
// answer keys, publish classes or declare its own suggestion verified.
import { describe, expect, it } from "vitest";
import { usdNanoFromCents } from "@educateos/ai-governance";
import type { CourseIntentProvider, CourseIntentPrompt } from "../src/index.ts";
import { PublisherTrust } from "../src/index.ts";
import bundle from "../../../curriculum/bundles/educateos.io/grade-1-reading-foundations/1.0.0.json" with { type: "json" };
import publisher from "../../../curriculum/educateos.io/publisher.json" with { type: "json" };
import { bootDistrict, expectError, NF } from "./support.ts";

const TRUST = PublisherTrust.parse({ localDomains: [], publishers: [publisher] });
const COURSE = { packageId: "educateos.io/grade-1-reading-foundations", version: "1.0.0" } as const;
const params = { offeringId: NF.eng9 };
const observed: CourseIntentPrompt[] = [];

const fakeProvider: CourseIntentProvider = {
  model: { provider: "cloudflare", modelId: "synthetic-model" },
  estimatedMaxUsdNano: usdNanoFromCents(5),
  async generate(input) {
    observed.push(structuredClone(input));
    return {
      intent: {
        profile: "educateos.pedagogical-intent/0.1", id: "vowel-adaptation", revision: "1.0.0",
        source: input.source, origin: "machine-suggestion",
        learningGoals: [{ id: "explain-vowels", statement: "Explain a vowel sound with an example.", alignments: [] }],
        prerequisites: [], misconceptions: [],
        strategies: [{ id: "low-tools", approach: "Use paper cards rather than a device.", conditions: [] }],
        expectedDemonstrations: [{
          id: "vowel-example", goalId: "explain-vowels",
          observable: "Explain one example aloud.", modality: "explain",
        }],
      },
      usage: { inputTokens: 110, outputTokens: 75, cacheReadTokens: 0, cacheWriteTokens: 0 },
      actualUsdNano: usdNanoFromCents(2),
    };
  },
};

async function setup(provider?: CourseIntentProvider) {
  const district = await bootDistrict(undefined, {
    courseLibraryTrust: TRUST,
    ...(provider === undefined ? {} : { courseIntentProvider: provider }),
  });
  const admin = district.tokenFor(NF.admin);
  const teacher = district.tokenFor(NF.rivera);
  await district.ok(admin, "admin.importCourseBundle", { body: structuredClone(bundle) as never });
  const plan = await district.ok(teacher, "teacher.previewCourseInstall", { params, body: COURSE });
  return { district, teacher, unitKey: plan.units[0]!.key };
}

describe("budgeted course intent suggestions (draft-only)", () => {
  it("restricts the provider to verified course metadata and settles the AI request", async () => {
    observed.length = 0;
    const { district, teacher, unitKey } = await setup(fakeProvider);
    const before = await district.ok(teacher, "teacher.listModules", { params });
    const installs = await district.stores.courseLibrary.loadInstalls(params.offeringId);
    const availability = await district.ok(teacher, "teacher.courseIntentAvailability", { params });
    expect(availability.available).toBe(true);

    const result = await district.ok(teacher, "teacher.suggestCourseIntent", {
      params, body: { ...COURSE, unitKey, goal: "low-equipment" },
    });
    expect(result.draftOnly).toBe(true);
    expect(result.intent.origin).toBe("machine-suggestion");
    expect(result.intent.source).toMatchObject({ ...COURSE, unitKey });
    expect(result.actualUsdNano).toBe(usdNanoFromCents(2));
    expect(result.warnings.join(" ")).toContain("Human review");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.goal).toBe("low-equipment");
    expect(Object.keys(observed[0]!)).not.toContain("studentId");
    expect(JSON.stringify(observed)).not.toContain("Amara");
    expect(observed[0]!.maxOutputTokens).toBe(750);
    expect(await district.ok(teacher, "teacher.listModules", { params })).toStrictEqual(before);
    expect(await district.stores.courseLibrary.loadInstalls(params.offeringId)).toStrictEqual(installs);
  });

  it("is disabled by default, refuses students and invalid unit IDs before inference", async () => {
    const off = await setup();
    expect((await off.district.ok(off.teacher, "teacher.courseIntentAvailability", { params })).available).toBe(false);
    expectError(await off.district.call(off.teacher, "teacher.suggestCourseIntent", {
      params, body: { ...COURSE, unitKey: off.unitKey, goal: "accessibility-first" },
    }), 503, "unavailable");

    observed.length = 0;
    const { district, teacher, unitKey } = await setup(fakeProvider);
    const student = district.tokenFor(NF.amara);
    expectError(await district.call(student, "teacher.suggestCourseIntent", {
      params, body: { ...COURSE, unitKey, goal: "language-scaffolding" },
    }), 403, "forbidden");
    expectError(await district.call(teacher, "teacher.suggestCourseIntent", {
      params, body: { ...COURSE, unitKey: "invented-unit", goal: "hands-on-practice" },
    }), 404, "not-found");
    expect(observed).toHaveLength(0);
  });

  it("rejects unsupported models, over-limit estimates and forged source outputs", async () => {
    const unsupported: CourseIntentProvider = {
      ...fakeProvider,
      model: { provider: "cloudflare", modelId: "not-in-district-catalog" },
    };
    const a = await setup(unsupported);
    expectError(await a.district.call(a.teacher, "teacher.suggestCourseIntent", {
      params, body: { ...COURSE, unitKey: a.unitKey, goal: "low-equipment" },
    }), 403, "policy-violation");

    const expensive: CourseIntentProvider = {
      ...fakeProvider, estimatedMaxUsdNano: usdNanoFromCents(11),
    };
    const b = await setup(expensive);
    expectError(await b.district.call(b.teacher, "teacher.suggestCourseIntent", {
      params, body: { ...COURSE, unitKey: b.unitKey, goal: "low-equipment" },
    }), 503, "unavailable");

    const forged: CourseIntentProvider = {
      ...fakeProvider,
      async generate(input) {
        const valid = await fakeProvider.generate(input);
        return { ...valid, intent: { ...(valid.intent as object), origin: "educator-draft" } };
      },
    };
    const c = await setup(forged);
    expectError(await c.district.call(c.teacher, "teacher.suggestCourseIntent", {
      params, body: { ...COURSE, unitKey: c.unitKey, goal: "low-equipment" },
    }), 400, "validation-failed");
  });
});
