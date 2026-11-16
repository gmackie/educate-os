/// <reference types="node" />
// Educator-reviewed learning recipes: matching without forced connections, teacher
// approval as the only gate, immutable versions, catalog compatibility, authorization and no leaks.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { PrincipalId } from "@educateos/contracts";
import { DurableObjectGuidanceStore, type DistrictSqlStorage } from "../src/durable-stores.ts";
import { RecipeContent, matchRecipeInterest, type LearningRecipeRecord } from "../src/learning-recipe.ts";
import { STARTER_RECIPES } from "../src/learning-recipe-starters.ts";
import { RECIPE_ROUTES } from "../src/routes.ts";
import { bootDistrict, expectError, NF, NORTHFIELD, RB, RIVERBEND, type TestDistrict } from "./support.ts";

const params = { offeringId: NF.eng9 };
const AMARA = PrincipalId.parse(NF.amara);
const MATH = "mathematics" as const;
/** Northfield's English 9 offering re-described as a class of the given subject and grade band. */
const klass = (subject: "mathematics" | "english-language-arts", gradeBand: string) => ({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => c.id === "crs_nf-english-9" ? { ...c, subject, gradeBand } : c) });
const mathSix = () => klass(MATH, "6");
const mathSeven = () => klass(MATH, "7");
const elaSix = () => klass("english-language-arts", "6");

const recipes = (d: TestDistrict, who: string = NF.rivera) => d.ok(d.tokenFor(who), "teacher.recipes", { params });
type Body = Awaited<ReturnType<typeof recipes>>;
const entryOf = (body: Body, starterId: string) => body.entries.find((e) => e.starterId === starterId)!;
const decide = async (d: TestDistrict, starterId: string, decision: "approve" | "reject" | "withdraw", extra: { content?: RecipeContent; note?: string; who?: string } = {}) => {
  const entry = entryOf(await recipes(d), starterId);
  return d.call(d.tokenFor(extra.who ?? NF.rivera), "teacher.recipeDecision", { params, body: { decision, starterId, revision: entry.revision, ...(extra.content ? { content: extra.content } : {}), ...(extra.note ? { note: extra.note } : {}) } });
};
const approve = async (d: TestDistrict, starterId: string, extra: Parameters<typeof decide>[3] = {}) => {
  const result = await decide(d, starterId, "approve", extra);
  expect(result.status).toBe(201);
  return result.body as Body;
};
const plan = (d: TestDistrict, goal: string, focus?: "6.RP.A.3b" | "W.6.1" | "7.RP.A.1") =>
  d.ok(d.tokenFor(NF.amara), "student.planGoal", { params, body: { goal, skills: [], ...(focus ? { focus } : {}) } });

const GAME = "g6-unit-rate-game-production", BASKETBALL = "g6-unit-rate-basketball-practice", BAKING = "g6-unit-rate-baking-prices", ARGUMENT = "g6-argument-evidence-decision", FRACTIONS = "g7-fraction-rates-recipes-and-pace";
const matches = (goal: string) => STARTER_RECIPES.filter((s) => matchRecipeInterest(goal, s.content.interest) !== undefined).map((s) => s.id);

describe("goal matching connects genuine interests and refuses weak ones", () => {
  it.each([
    ["I want to build a Roblox pizza tycoon", [GAME]],
    ["make a minecraft farm game where machines produce wheat", [GAME]],
    ["I want to get better at basketball free throws", [BASKETBALL]],
    ["Plan a bake sale and compare cookie prices", [BAKING]],
    ["I want to convince the school to change the phone rule", [ARGUMENT]],
    ["double a recipe that needs 1/2 cup of sugar", [FRACTIONS]],
    ["figure out my bike pace in miles per hour", [FRACTIONS]],
  ])("%s", (goal, expected) => expect(matches(goal)).toEqual(expected));

  it.each([
    "I want to eat pizza", "I want to watch basketball", "I love baking cookies", "build a roblox game", "I want to learn astronomy",
    "I don't want to make a pizza tycoon", "I want to cheat at a roblox pizza tycoon", "I argue with my brother", "",
  ])("offers nothing for %j", (goal) => expect(matches(goal)).toEqual([]));

  it("reports the recipe's own words that matched, and ignores case and plural forms", () => {
    const game = STARTER_RECIPES.find((s) => s.id === GAME)!;
    expect(matchRecipeInterest("ROBLOX Pizzas and Tycoons", game.content.interest)).toMatchObject({ matched: ["roblox", "tycoon", "pizza"] });
  });

  it("ships starters that are unreviewed proposals with no canonical identifiers", () => {
    for (const s of STARTER_RECIPES) {
      expect(RecipeContent.parse(s.content)).toEqual(s.content);
      expect(JSON.stringify(s.content)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|https?:\/\//);
    }
    expect(STARTER_RECIPES.map((s) => s.content.standard.label).toSorted()).toEqual(["6.RP.A.3b", "6.RP.A.3b", "6.RP.A.3b", "7.RP.A.1", "W.6.1"]);
  });
});

describe("teacher approval is the only way a recipe reaches students", () => {
  it("lists unreviewed starters with a live standards check and creates nothing for students", async () => {
    const d = await bootDistrict(mathSix());
    const body = await recipes(d);
    expect(body).toMatchObject({ paused: false, engaged: false });
    expect(body.entries.map((e) => e.status)).toEqual(Array(5).fill("unreviewed"));
    expect(entryOf(body, GAME)).toMatchObject({ version: 0, revision: 0, origin: { kind: "starter" }, standardCheck: { state: "ok" } });
    expect(entryOf(body, ARGUMENT).standardCheck.state).toBe("subject-mismatch");
    expect(entryOf(body, FRACTIONS).standardCheck.state).toBe("grade-mismatch");
  });

  it("offers an approved recipe with transparent origin, pinned catalog item and its own task, lesson and rubric", async () => {
    const d = await bootDistrict(mathSix());
    await approve(d, GAME, { note: "Fits our unit on rates." });
    const p = await plan(d, "I want to build a Roblox pizza tycoon");
    expect(p.opportunities).toHaveLength(1);
    const o = p.opportunities[0]!;
    const starter = STARTER_RECIPES.find((s) => s.id === GAME)!.content;
    const state = (await d.app.catalog.get("ccss-math"))!;
    expect(o).toMatchObject({
      code: "6.RP.A.3b", frameworkKey: "ccss-math", decision: "offered", task: starter.studentTask, reviews: [],
      node: { humanCodingScheme: "6.RP.A.3" }, releaseDigest: state.releases.find((r) => r.status === "approved")!.release.contentDigest,
      recipe: { version: 1, origin: "starter", approvedBy: "Sam Rivera", interestLabel: "game production", standardLabel: "6.RP.A.3b", whyNow: starter.whyNow, matched: ["roblox", "tycoon", "pizza"] },
    });
    expect(o.coaching!.lesson.steps).toHaveLength(starter.steps.length);
    expect(o.coaching!.lesson.challenge).toBe(starter.independentChallenge);
    expect(o.contract.criteria.map((c) => c.description)).toEqual(starter.transfer.rubric);
    expect(o.contract.provenance.sourceUri).toBe(`urn:educateos:learning-recipe:${o.recipe!.recipeId}`);
    expect(o.reason).toContain("Sam Rivera approved");
    expect((await d.stores.assessment.load()).state.assignments).toEqual([]);
  });

  it("falls back to the fixed mapping only until a class makes its first recipe decision", async () => {
    const d = await bootDistrict(mathSix());
    expect((await plan(d, "I want to eat pizza")).opportunities.map((o) => o.recipe)).toEqual([undefined, undefined]);
    await approve(d, BASKETBALL);
    expect((await plan(d, "I want to eat pizza")).opportunities).toEqual([]);
    expect((await plan(d, "I want to build a Roblox pizza tycoon")).opportunities).toEqual([]);
    expect((await plan(d, "I want to improve at basketball practice")).opportunities.map((o) => o.recipe?.interestLabel)).toEqual(["basketball practice"]);
  });

  it("a rejected recipe is never offered and cannot be rejected twice or withdrawn", async () => {
    const d = await bootDistrict(mathSix());
    await approve(d, BAKING);
    const rejected = await decide(d, GAME, "reject", { note: "Not our focus." });
    expect(rejected.status).toBe(201);
    expect(entryOf(rejected.body as Body, GAME)).toMatchObject({ status: "rejected", version: 1, audit: [{ action: "rejected", byName: "Sam Rivera", note: "Not our focus." }] });
    expect((await plan(d, "I want to build a Roblox pizza tycoon")).opportunities).toEqual([]);
    expectError(await decide(d, GAME, "reject"), 409, "conflict");
    expectError(await decide(d, GAME, "withdraw"), 409, "conflict");
    expectError(await decide(d, BAKING, "reject"), 409, "conflict");
  });

  it("an explicit standards focus uses an approved recipe for that standard only", async () => {
    const d = await bootDistrict(mathSix());
    expect((await plan(d, "Build a garden", "6.RP.A.3b")).opportunities.length).toBe(1);
    await approve(d, BASKETBALL);
    const focused = await plan(d, "Build a garden", "6.RP.A.3b");
    expect(focused.opportunities.map((o) => [o.code, o.recipe?.matched])).toEqual([["6.RP.A.3b", []]]);
    expect((await plan(d, "Build a garden", "7.RP.A.1" as never).catch(() => ({ opportunities: [] }))).opportunities).toEqual([]);
  });

  it("serves a grade 7 class and an ELA class only their own approved standards", async () => {
    const seven = await bootDistrict(mathSeven());
    expectError(await decide(seven, GAME, "approve"), 409, "conflict");
    await approve(seven, FRACTIONS);
    expect((await plan(seven, "double a recipe that needs 1/2 cup of sugar")).opportunities.map((o) => o.code)).toEqual(["7.RP.A.1"]);
    const ela = await bootDistrict(elaSix());
    expectError(await decide(ela, GAME, "approve"), 409, "conflict");
    await approve(ela, ARGUMENT);
    const p = await plan(ela, "I want to convince the school to change the phone rule");
    expect(p.opportunities.map((o) => [o.code, o.node.humanCodingScheme])).toEqual([["W.6.1", "W.6.1"]]);
  });
});

describe("approval refuses anything the district's approved standards do not support", () => {
  const edited = async (d: TestDistrict, mutate: (c: RecipeContent) => RecipeContent) => mutate(structuredClone(entryOf(await recipes(d), GAME).content));

  it("refuses wrong subject, wrong grade, unapproved frameworks, unknown items and unmatched statements", async () => {
    const d = await bootDistrict(mathSix());
    const refused = async (mutate: (c: RecipeContent) => RecipeContent, code: string) => {
      const result = await decide(d, GAME, "approve", { content: await edited(d, mutate) });
      expectError(result, 409, "conflict");
      return (result.body as { message: string }).message;
    };
    expect(await refused((c) => ({ ...c, standard: { ...c.standard, frameworkKey: "ccss-ela", code: "W.6.1" } }), "subject")).toContain("subject");
    expect(await refused((c) => ({ ...c, standard: { ...c.standard, gradeLevels: ["07"] } }), "grade")).toContain("grade");
    // Texas and Michigan are declared pointers with no approved items: no mapping is asserted for them.
    expect(await refused((c) => ({ ...c, standard: { ...c.standard, frameworkKey: "teks", code: "6.4" } }), "teks")).toContain("not approved");
    expect(await refused((c) => ({ ...c, standard: { ...c.standard, frameworkKey: "michigan", code: "6.RP.A.3" } }), "michigan")).toContain("not approved");
    expect(await refused((c) => ({ ...c, standard: { ...c.standard, frameworkKey: "tx-made-up" } }), "unknown")).toContain("not a standards framework");
    expect(await refused((c) => ({ ...c, standard: { ...c.standard, code: "6.RP.Z.9" } }), "item")).toContain("no item 6.RP.Z.9");
    expect(await refused((c) => ({ ...c, standard: { ...c.standard, statementIncludes: "Solve every possible problem" } }), "statement")).toContain("does not contain");
    expect(await refused((c) => ({ ...c, prerequisites: [{ concept: "Dividing", standardCode: "6.ZZ.Z.9" }] }), "prereq")).toContain("prerequisite standard 6.ZZ.Z.9");
    expect((await recipes(d)).engaged).toBe(false);
  });

  it("requires prerequisites, bounded plain text and a rubric, and only accepts edits with an approval", async () => {
    const d = await bootDistrict(mathSix());
    const base = await edited(d, (c) => c);
    const send = (content: unknown) => d.call(d.tokenFor(NF.rivera), "teacher.recipeDecision", { params, body: { decision: "approve", starterId: GAME, revision: 0, content: content as never } });
    expect((await send({ ...base, prerequisites: [] })).status).toBe(400);
    expect((await send({ ...base, studentTask: "Visit https://example.com/cheats to finish" })).status).toBe(400);
    expect((await send({ ...base, transfer: { ...base.transfer, rubric: ["only one"] } })).status).toBe(400);
    expect((await send({ ...base, mastery: "demonstrated" })).status).toBe(400);
    expect((await d.call(d.tokenFor(NF.rivera), "teacher.recipeDecision", { params, body: { decision: "reject", starterId: GAME, revision: 0, content: base } })).status).toBe(400);
    expect((await send({ ...base, prerequisites: [{ concept: "Dividing", standardCode: "6.RP.A.3" }] })).status).toBe(201);
  });

  it("an edit is a new immutable version: the old approval is superseded and earlier plans keep their digest", async () => {
    const d = await bootDistrict(mathSix());
    const first = entryOf(await approve(d, GAME), GAME);
    const early = await plan(d, "I want to build a Roblox pizza tycoon");
    expectError(await decide(d, GAME, "approve"), 409, "conflict");
    const content = { ...first.content, whyNow: "Our class is comparing machines this week.", studentTask: `${first.content.studentTask} Use two ovens from your own game.` };
    const second = entryOf(await approve(d, GAME, { content }), GAME);
    expect(second).toMatchObject({ version: 2, status: "approved", origin: { kind: "starter-edited", starterId: GAME } });
    expect(second.recipeId).toBe(first.recipeId);
    const stored = (await d.stores.guidance.records.list(NF.eng9)).filter((r): r is LearningRecipeRecord => r.type === "recipe").toSorted((a, b) => a.version - b.version);
    expect(stored.map((r) => [r.version, r.status])).toEqual([[1, "withdrawn"], [2, "approved"]]);
    expect(stored[0]!.contentDigest).toBe(first.contentDigest);
    expect(stored[0]!.content).toEqual(first.content);
    expect(stored[0]!.audit.map((a) => a.action)).toEqual(["approved", "superseded"]);
    const later = await plan(d, "I want to build a Roblox pizza tycoon");
    expect(later.opportunities[0]!.recipe).toMatchObject({ version: 2, whyNow: content.whyNow });
    expect(later.opportunities[0]!.task).toContain("two ovens");
    const reread = (await d.ok(d.tokenFor(NF.amara), "student.planner", { params })).find((p) => p.id === early.id)!;
    expect(reread.opportunities[0]!.recipe).toMatchObject({ version: 1, contentDigest: first.contentDigest });
  });

  it("withdrawing stops new offers, keeps history, and refuses stale revisions", async () => {
    const d = await bootDistrict(mathSix());
    const approved = entryOf(await approve(d, GAME), GAME);
    const early = await plan(d, "I want to build a Roblox pizza tycoon");
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.recipeDecision", { params, body: { decision: "withdraw", starterId: GAME, revision: approved.revision + 5 } }), 409, "conflict");
    const withdrawn = entryOf((await decide(d, GAME, "withdraw", { note: "Revisit next term." })).body as Body, GAME);
    expect(withdrawn).toMatchObject({ status: "withdrawn", audit: [{ action: "approved" }, { action: "withdrawn", note: "Revisit next term." }] });
    expect((await plan(d, "I want to build a Roblox pizza tycoon")).opportunities).toEqual([]);
    expect((await d.ok(d.tokenFor(NF.amara), "student.planner", { params })).find((p) => p.id === early.id)!.opportunities).toHaveLength(1);
    expectError(await decide(d, GAME, "withdraw"), 409, "conflict");
    // A withdrawn recipe can be approved again as a new version.
    expect(entryOf(await approve(d, GAME), GAME)).toMatchObject({ version: 2, status: "approved" });
  });

  it("the pause switch stops every connection for the class and is revision-checked", async () => {
    const d = await bootDistrict(mathSix());
    await approve(d, GAME);
    const paused = await d.ok(d.tokenFor(NF.rivera), "teacher.recipeSettings", { params, body: { revision: 0, paused: true } });
    expect(paused).toMatchObject({ paused: true, settingsRevision: 1, engaged: true });
    expect((await plan(d, "I want to build a Roblox pizza tycoon")).opportunities).toEqual([]);
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.recipeSettings", { params, body: { revision: 0, paused: false } }), 409, "conflict");
    await d.ok(d.tokenFor(NF.rivera), "teacher.recipeSettings", { params, body: { revision: 1, paused: false } });
    expect((await plan(d, "I want to build a Roblox pizza tycoon")).opportunities).toHaveLength(1);
  });
});

describe("stale, withdrawn or tampered standards never reach a student plan", () => {
  it("retires an approved recipe when the district withdraws the standards, and revives it with the same release", async () => {
    const d = await bootDistrict(mathSix());
    await approve(d, GAME);
    await d.ok(d.tokenFor(NF.admin), "admin.withdrawStandards", { params: { frameworkKey: "ccss-math" } });
    expect((await plan(d, "I want to build a Roblox pizza tycoon")).opportunities).toEqual([]);
    expect(entryOf(await recipes(d), GAME)).toMatchObject({ status: "approved", standardCheck: { state: "not-approved" } });
    await d.ok(d.tokenFor(NF.admin), "admin.approveStandards", { params: { frameworkKey: "ccss-math" } });
    expect((await plan(d, "I want to build a Roblox pizza tycoon")).opportunities).toHaveLength(1);
  });

  it("refuses a recipe whose item the district hid", async () => {
    const d = await bootDistrict(mathSix());
    await approve(d, GAME);
    const node = (await plan(d, "I want to build a Roblox pizza tycoon")).opportunities[0]!.node;
    await d.app.catalog.setOverlay("ccss-math", { nodeUri: node.uri, hidden: true, author: PrincipalId.parse(NF.admin), updatedAt: "2026-11-15T12:00:00Z" });
    expect((await plan(d, "I want to build a Roblox pizza tycoon")).opportunities).toEqual([]);
    expect(entryOf(await recipes(d), GAME).standardCheck.state).toBe("hidden");
  });

  it("refuses an old approval pinned to a different release digest, even though its record still exists", async () => {
    const d = await bootDistrict(mathSix());
    const entry = entryOf(await approve(d, GAME), GAME);
    const [record] = (await d.stores.guidance.records.list(NF.eng9)).filter((r): r is LearningRecipeRecord => r.type === "recipe");
    await d.stores.guidance.records.save({ ...record!, revision: record!.revision + 1, pin: { ...record!.pin!, releaseDigest: "sha256:an-older-release" } }, record!.revision);
    expect((await plan(d, "I want to build a Roblox pizza tycoon")).opportunities).toEqual([]);
    expect(entryOf(await recipes(d), GAME)).toMatchObject({ status: "approved", standardCheck: { state: "stale" } });
    expect(entry.status).toBe("approved");
  });

  it("refuses a stored plan whose label names a standard its pinned item does not", async () => {
    const d = await bootDistrict(mathSix());
    await approve(d, GAME);
    const p = await plan(d, "I want to build a Roblox pizza tycoon");
    const forged = structuredClone(p);
    forged.revision++;
    forged.opportunities[0]!.code = "6.NS.B.3";
    await expect(d.stores.planner.save(forged, p.revision)).rejects.toThrow();
  });
});

describe("authorization and privacy", () => {
  it("only the class's active teachers can read or decide, in their own district", async () => {
    const d = await bootDistrict(mathSix());
    const student = d.tokenFor(NF.amara);
    expectError(await d.call(student, "teacher.recipes", { params }), 403, "forbidden");
    expectError(await d.call(student, "teacher.recipeDecision", { params, body: { decision: "approve", starterId: GAME, revision: 0 } }), 403, "forbidden");
    expectError(await d.call(student, "teacher.recipeSettings", { params, body: { revision: 0, paused: true } }), 403, "forbidden");
    expectError(await d.call(d.tokenFor(NF.morgan), "teacher.recipes", { params }), 403, "forbidden");
    expectError(await decide(d, GAME, "approve", { who: NF.morgan }), 403, "forbidden");
    expectError(await d.call(d.tokenFor(NF.admin), "teacher.recipes", { params }), 403, "forbidden");
    // A co-teacher gets exactly what the course policy gives them for guidance: reading, not authoring.
    expect((await d.call(d.tokenFor(NF.chen), "teacher.recipes", { params })).status).toBe(200);
    expectError(await decide(d, GAME, "approve", { who: NF.chen }), 403, "forbidden");
    expect((await decide(d, GAME, "approve")).status).toBe(201);
    const rb = await bootDistrict(RIVERBEND);
    expectError(await rb.call(rb.tokenFor(RB.teacher), "teacher.recipes", { params }), 404, "not-found");
    expect(await rb.stores.guidance.records.list(NF.eng9)).toEqual([]);
    expect(Object.values(RECIPE_ROUTES).map((r) => r.surface)).toEqual(["teacher", "teacher", "teacher"]);
  });

  it("never shows teachers the learner's goal or the words that matched, only the approved recipe", async () => {
    const d = await bootDistrict(mathSix());
    await approve(d, GAME);
    const student = d.tokenFor(NF.amara);
    let p = await plan(d, "PRIVATE: my Roblox pizza tycoon for Mia");
    expect(p.opportunities[0]!.recipe!.matched).toContain("roblox");
    const target = { ...params, planId: p.id, opportunityId: p.opportunities[0]!.id };
    p = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: p.revision, decision: "accepted" } });
    await d.ok(student, "student.plannerShare", { params: target, body: { revision: p.revision, text: "Oven A makes 4 pizzas per minute.", assistance: "ai" } });
    const view = await d.ok(d.tokenFor(NF.rivera), "teacher.planner", { params });
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/PRIVATE|Mia|roblox/i);
    expect(view[0]!.opportunities[0]!.recipe).toMatchObject({ title: "Unit rates in a game production line", version: 1, matched: [] });
    const guidance = JSON.stringify(await d.ok(d.tokenFor(NF.rivera), "teacher.guidance", { params }));
    expect(guidance).not.toMatch(/PRIVATE|Mia|roblox/i);
  });

  it("keeps recipe records out of a student's records, purge and durable store lifecycle", async () => {
    const d = await bootDistrict(mathSix());
    await approve(d, GAME);
    await plan(d, "I want to build a Roblox pizza tycoon");
    const store = d.stores.guidance.records as unknown as { subjectRecords(id: string): unknown[]; eraseSubject(id: string): void };
    expect(store.subjectRecords(AMARA)).toEqual([]);
    store.eraseSubject(AMARA);
    expect((await d.stores.guidance.records.list(NF.eng9)).filter((r) => r.type === "recipe")).toHaveLength(1);
    const db = new DatabaseSync(":memory:");
    const storage: DistrictSqlStorage = {
      sql: { exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings.map((b) => b instanceof ArrayBuffer ? new Uint8Array(b) : b)); return { toArray: () => rows }; } },
      transactionSync(closure) { db.exec("BEGIN"); try { const result = closure(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } },
    };
    try {
      const [record] = (await d.stores.guidance.records.list(NF.eng9)).filter((r): r is LearningRecipeRecord => r.type === "recipe");
      const durable = new DurableObjectGuidanceStore(storage);
      await durable.save(record!, 0);
      expect(await new DurableObjectGuidanceStore(storage).list(NF.eng9)).toEqual([record]);
      await expect(durable.save(record!, 0)).rejects.toMatchObject({ code: "conflict" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM educateos_guidance WHERE json_extract(record_json, '$.type') != 'agenda' AND json_extract(record_json, '$.studentId') = ?").get(AMARA)).toEqual({ n: 0 });
    } finally { db.close(); }
  });
});

describe("a recipe opportunity grants no mastery", () => {
  it("lets the learner skip, treats AI-generated work as practice only, and needs separate independent teacher evidence", async () => {
    const d = await bootDistrict(mathSix());
    await approve(d, GAME);
    const student = d.tokenFor(NF.amara);
    const p = await plan(d, "I want to build a Roblox pizza tycoon");
    const target = { ...params, planId: p.id, opportunityId: p.opportunities[0]!.id };
    const skipped = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: p.revision, decision: "skipped" } });
    expect((await d.ok(student, "student.plannerKnowledge", { params })).competencies[0]!.status).toBe("unverified");
    const again = await plan(d, "I want to build a Roblox pizza tycoon");
    const t2 = { ...params, planId: again.id, opportunityId: again.opportunities[0]!.id };
    const accepted = await d.ok(student, "student.plannerDecision", { params: t2, body: { revision: again.revision, decision: "accepted" } });
    const shared = await d.ok(student, "student.plannerShare", { params: t2, body: { revision: accepted.revision, text: "-- Lua: the game computes 4 pizzas per minute for me", assistance: "ai" } });
    expect(skipped.opportunities[0]!.decision).toBe("skipped");
    expect((await d.ok(student, "student.plannerKnowledge", { params })).competencies.find((c) => c.status !== "unverified")!.status).toBe("practiced");
    const review = { level: "demonstrated" as const, assistance: "ai" as const, independentlyAssessed: true, decision: "recommend" as const, rationale: "The generated code runs.", assessment: { method: "independent-task" as const, observedAt: new Date().toISOString(), context: "Ran the game." } };
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: t2, body: { ...review, revision: shared.revision } }), 409, "conflict");
    expect((await d.ok(student, "student.plannerKnowledge", { params })).competencies.every((c) => c.status === "unverified" || c.status === "practiced")).toBe(true);
  });
});
