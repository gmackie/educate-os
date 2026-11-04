// OCS 1.1 portable activities (RFC 0001 §13.1, §14): the export format and its refusals, its
// digest and signature context, the 1.0/1.1 version rules, libraries, resolution and composition
// carrying portable references, and the install plan through the reference in-memory target.
import { ResourceId, RubricId } from "@educateos/contracts";
import type { OfferingScope } from "@educateos/curriculum";
import { keyIdFor, SigningIdentity } from "@educateos/fleet";
import { checkActivityContent, generateActivity } from "@educateos/curriculum";
import { describe, expect, it } from "vitest";
import {
  type ActivityExportInput,
  activityExportDigest,
  applyInstallPlan,
  checkExportPublication,
  checkPublication,
  composeCourse,
  editCourse,
  formatJson,
  importPlannedActivities,
  InMemoryCourseInstallTarget,
  InMemoryPackageLibrary,
  type OcsActivity,
  planCourseInstall,
  planInstallations,
  publish,
  publisherExportPolicy,
  type PublisherTrust,
  readActivityExport,
  readPackage,
  resolveActivityExports,
  resolveCourse,
  signActivityExportPublication,
  signPackagePublication,
  templateInputFor,
  writeActivityExport,
} from "../src/index.ts";
import { IDS, libraryOf, packageFiles, rejectsWithProblem, unit } from "./helpers.ts";

const NOW = new Date("2026-10-21T09:00:00Z");
const RF13 = { frameworkKey: "ccss-ela", competencyUri: "urn:educateos:catalog:ccss-ela:CCSS.ELA-LITERACY.RF.1.3" };
const RL12 = { frameworkKey: "ccss-ela", competencyUri: "urn:educateos:catalog:ccss-ela:CCSS.ELA-LITERACY.RL.1.2" };
const OFFERING = { level: "offering", districtId: "dst_northfield", schoolId: "sch_northfield-high", offeringId: "off_bio-9-p1" } as OfferingScope;

const common = { subject: "english-language-arts", gradeBand: "1", aiHelp: "hints-only", due: { kind: "after-install", days: 5 } } as const;

/** A read-and-respond export, with one reading and a rubric. */
const wordBuilders = (overrides: Partial<Record<string, unknown>> = {}): ActivityExportInput => ({
  specVersion: "1.1",
  id: "openbio.example/word-builders",
  version: "1.0.0",
  language: "en",
  activity: {
    template: "read-and-respond",
    ...common,
    title: "Word Builders",
    overview: "Change one sound to make a new word.",
    passage: "Let's build words! Say a word. Change one sound.",
    questions: [{ prompt: "Say cat. Change the first sound to /h/." }],
    answerBy: "writing",
    sentenceFrames: [],
    resources: ["chant"],
  },
  rubric: {
    title: "Word builders",
    criteria: [{ id: "sounds", title: "I changed the sound", levels: [{ id: "not-yet", label: "Not yet", points: 1 }, { id: "got-it", label: "Got it!", points: 3 }] }],
  },
  alignments: [RF13],
  readings: [{ id: "chant", title: "Word chant", body: "Cat, hat, bat, sat." }],
  ...overrides,
}) as ActivityExportInput;

/** One export of every template, so each is shown to make a valid curriculum activity. */
const EVERY_TEMPLATE: ActivityExportInput["activity"][] = [
  { template: "writing-task", ...common, title: "My pet", overview: "Write about a pet.", prompt: "Tell about a pet.", genre: "narrative", minimumCitations: 0 } as ActivityExportInput["activity"],
  { template: "science-investigation", ...common, title: "Plants", overview: "Grow beans.", question: "Do beans need light?", methodPrompt: "Plan it.", dataColumns: [{ name: "Day" }], analysisPrompt: "What happened?" } as ActivityExportInput["activity"],
  { template: "primary-source-analysis", ...common, title: "Letters", overview: "Read a letter.", sources: ["chant"], sourcingQuestions: ["Who wrote it?"], contextualizationQuestions: ["When?"], claimPrompt: "Why?", minimumEvidence: 1 } as ActivityExportInput["activity"],
  { template: "problem-set", ...common, title: "Adding", overview: "Add.", problems: [{ prompt: "2 + 3 = ?" }], showWork: true } as ActivityExportInput["activity"],
  { template: "picture-response", ...common, title: "Pond", overview: "Draw a pond.", lookPrompt: "Look at the pond.", drawPrompt: "Draw an animal.", tellAboutIt: true, sentenceFrames: ["I drew a ___."] } as ActivityExportInput["activity"],
  wordBuilders().activity,
];

const text = (exported: unknown) => formatJson(exported);

/** A 1.1 course with one unit holding a portable activity and two Codex notes. */
async function portableCourse(ref: { id: string; version: string; digest: string }, specVersion: "1.0" | "1.1" = "1.1") {
  return packageFiles({
    manifest: { specVersion, id: IDS.course, version: "1.0.0", outline: [{ kind: "unit", unit: "sounds" }] },
    units: [unit("sounds", [{ kind: "codex", ref: "overview" }, { kind: "activity", ref: "builders" }, { kind: "codex", ref: "key" }], "Short Vowel Sounds")],
    activities: [{ id: "builders", title: "Word Builders", role: "assignment", definition: { portable: ref } } as OcsActivity],
    codex: [
      { id: "overview", title: "Sounds We Know", body: "Every word has a vowel.", purpose: "context", visibility: "students" },
      { id: "key", title: "Answer key", body: "1. hat", purpose: "answer-key", visibility: "teacher-only" },
    ],
  });
}

async function publishedExport(exported: ActivityExportInput = wordBuilders()) {
  const library = new InMemoryPackageLibrary();
  const published = await library.publishExport(text(exported));
  return { library, ref: { id: exported.id, version: exported.version, digest: published.digest } };
}

describe("activity exports", () => {
  it("read strictly, with a digest that ignores formatting and follows content", async () => {
    const parsed = await readActivityExport(text(wordBuilders()));
    expect(parsed.export.activity.template).toBe("read-and-respond");
    expect(parsed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await activityExportDigest(JSON.stringify(wordBuilders()))).toBe(parsed.digest);
    expect(await activityExportDigest(writeActivityExport(wordBuilders()))).toBe(parsed.digest);
    expect(await activityExportDigest(text(wordBuilders({ version: "1.0.1" })))).not.toBe(parsed.digest);
  });

  it("refuse anything district-local, any answer, and any unknown field", async () => {
    const base = wordBuilders();
    const refusals: unknown[] = [
      { ...base, scope: OFFERING },
      { ...base, savedBy: "prn_someone" },
      { ...base, activity: { ...base.activity, codex: [] } },
      { ...base, activity: { ...base.activity, alignments: [RF13] } },
      { ...base, activity: { ...base.activity, responseRubric: { rubricId: "rbr_x", version: 1 } } },
      { ...base, activity: { ...base.activity, resources: [{ resourceId: "rsc_x", version: "1.0.0" }] } },
      { ...base, activity: { ...base.activity, due: { kind: "fixed", dueAt: "2026-11-01T00:00:00Z" } } },
      { ...base, activity: { template: "problem-set", ...common, title: "Add", overview: "Add.", problems: [{ prompt: "1 + 1", answer: "2" }], showWork: false } },
      { ...base, code: "export default {}" },
      { ...base, specVersion: "1.0" },
      { ...base, id: "word-builders" },
      { ...base, rubric: { title: "R", criteria: [{ id: "a", title: "A", levels: [], checks: [] }] } },
    ];
    for (const exported of refusals) await rejectsWithProblem(readActivityExport(text(exported)), "invalid-export");
  });

  it("apply the plain-text rule to every string, and check readings and rubric levels", async () => {
    const base = wordBuilders();
    await rejectsWithProblem(readActivityExport(text({ ...base, activity: { ...base.activity, sentenceFrames: ["<script>x</script>"] } })), "invalid-export", /active markup/);
    await rejectsWithProblem(readActivityExport(text({ ...base, readings: [{ id: "chant", title: "Chant", body: "javascript:alert(1)" }] })), "invalid-export", /active markup/);
    await rejectsWithProblem(readActivityExport(text({ ...base, readings: [] })), "invalid-export", /no reading chant/);
    const levels = [{ id: "a", label: "A", points: 3 }, { id: "b", label: "B", points: 1 }];
    await rejectsWithProblem(readActivityExport(text({ ...base, rubric: { title: "R", criteria: [{ id: "c", title: "C", levels }] } })), "invalid-export", /lowest first/);
    await rejectsWithProblem(readActivityExport("{not json"), "invalid-export", /not valid JSON/);
  });

  it("become valid curriculum activities for every template", async () => {
    for (const activity of EVERY_TEMPLATE) {
      const exported = (await readActivityExport(text(wordBuilders({ activity })))).export;
      const input = templateInputFor(exported, { readings: new Map([["chant", { resourceId: ResourceId.parse("rsc_chant"), version: "1.0.0" }]]), rubric: { rubricId: RubricId.parse("rbr_rubric"), version: 1 } });
      const content = generateActivity(input);
      expect(checkActivityContent(content)).toStrictEqual([]);
      expect(content.evidence.alignments).toStrictEqual([RF13]);
      expect(content.rubricSlots[0]!.rubric).toStrictEqual({ rubricId: "rbr_rubric", version: 1 });
    }
    const exported = (await readActivityExport(text(wordBuilders()))).export;
    expect(() => templateInputFor(exported, { readings: new Map() })).toThrow(/no release of reading chant/);
  });
});

async function signatureSetup() {
  const publisher = await SigningIdentity.generate();
  const trust: PublisherTrust = { localDomains: ["northfield.example"], publishers: [{ domain: "openbio.example", keys: [{ keyId: await keyIdFor(publisher.publicKey), publicKey: publisher.publicKey }] }] };
  const parsed = await readActivityExport(text(wordBuilders()));
  const statement = { exportId: parsed.export.id, version: parsed.export.version, digest: parsed.digest, publishedAt: "2026-10-20T09:00:00Z" };
  return { publisher, trust, parsed, statement, target: { id: parsed.export.id, version: parsed.export.version, digest: parsed.digest } };
}

describe("export signatures", () => {
  it("accept an export signed by an approved key, and refuse it unsigned or for another export", async () => {
    const { publisher, trust, statement, target } = await signatureSetup();
    const signature = await signActivityExportPublication(publisher, statement);
    expect(await checkExportPublication(target, signature, trust, NOW)).toStrictEqual({ ok: true, signed: true });
    expect(await checkExportPublication(target, undefined, trust, NOW)).toStrictEqual({ ok: false, reason: "unsigned" });
    expect(await checkExportPublication({ ...target, version: "1.0.1" }, signature, trust, NOW)).toStrictEqual({ ok: false, reason: "wrong-package" });
    const stranger = await SigningIdentity.generate();
    expect(await checkExportPublication(target, await signActivityExportPublication(stranger, statement), trust, NOW)).toStrictEqual({ ok: false, reason: "unknown-publisher" });
  });

  it("never confuse a package signature with an export signature, even over the same digest", async () => {
    const { publisher, trust, statement, target } = await signatureSetup();
    const asPackage = await signPackagePublication(publisher, { packageId: statement.exportId, version: statement.version, digest: statement.digest, publishedAt: statement.publishedAt });
    expect(await checkExportPublication(target, asPackage, trust, NOW)).toStrictEqual({ ok: false, reason: "bad-signature" });
    const asExport = await signActivityExportPublication(publisher, statement);
    const pkg = { manifest: { id: statement.exportId, version: statement.version }, digest: statement.digest } as Parameters<typeof checkPublication>[0];
    expect(await checkPublication(pkg, asExport, trust, NOW)).toStrictEqual({ ok: false, reason: "bad-signature" });
  });

  it("is the library policy for exports", async () => {
    const { publisher, trust, parsed, statement } = await signatureSetup();
    const policy = publisherExportPolicy(trust, () => NOW);
    await expect(policy(parsed, undefined)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await policy(parsed, await signActivityExportPublication(publisher, statement))).toStrictEqual({ signed: true });
  });
});

describe("1.0 and 1.1 packages", () => {
  it("read a 1.1 package with a portable activity, and refuse one declared 1.0", async () => {
    const { ref } = await publishedExport();
    const pkg = await readPackage(await portableCourse(ref));
    expect(pkg.activities.get("builders")!.definition).toStrictEqual({ portable: ref });
    await rejectsWithProblem(readPackage(await portableCourse(ref, "1.0")), "invalid-package", /portable activity needs specVersion "1.1"/);
  });

  it("refuse a format version this reader does not know, and a malformed portable reference", async () => {
    const { ref } = await publishedExport();
    const files = await portableCourse(ref);
    const manifest = JSON.parse(files["ocs.json"]!);
    await rejectsWithProblem(readPackage({ ...files, "ocs.json": formatJson({ ...manifest, specVersion: "1.2" }) }), "invalid-package");
    const bad = { id: "builders", title: "B", role: "lesson", definition: { portable: { id: ref.id, version: "1", digest: ref.digest } } };
    await rejectsWithProblem(readPackage({ ...files, "activities/builders.json": formatJson(bad) }), "invalid-package");
    const both = { id: "builders", title: "B", role: "lesson", definition: { portable: ref, definitionId: "adf_x", version: 1 } };
    await rejectsWithProblem(readPackage({ ...files, "activities/builders.json": formatJson(both) }), "invalid-package");
  });

  it("lock a course 1.1 when it includes a 1.1 module, and keep 1.0 courses 1.0", async () => {
    const { ref } = await publishedExport();
    const module = { ...(await portableCourse(ref)), "ocs.json": formatJson({ ...JSON.parse((await portableCourse(ref))["ocs.json"]!), id: IDS.bio }) };
    const library = await libraryOf(module);
    const root = await readPackage(packageFiles({ manifest: { id: "northfield.example/reading", version: "1.0.0", modules: [{ name: "core", package: IDS.bio, range: "^1.0.0" }], outline: [{ kind: "module", module: "core" }] } }));
    const resolution = await resolveCourse(root, library);
    expect(resolution.lock.specVersion).toBe("1.1");
    const course = composeCourse(resolution);
    expect(course.units[0]!.items.find((item) => item.kind === "activity")).toMatchObject({ key: "core:sounds#builders", activity: { definition: { portable: ref } } });
    const plain = await readPackage(packageFiles({ manifest: { id: IDS.safety, version: "1.0.0", outline: [{ kind: "unit", unit: "rules" }] }, units: [unit("rules", [])] }));
    expect((await resolveCourse(plain, library)).lock.specVersion).toBe("1.0");
  });

  it("publish a draft that gains a portable activity as 1.1", async () => {
    const { ref } = await publishedExport();
    // A draft whose manifest still says 1.0 (as `startCourse` writes it) is published as 1.1.
    const draft = await editCourse(await portableCourse(ref));
    const published = await publish({ ...draft, manifest: { ...draft.manifest, specVersion: "1.0" }, published: undefined }, new InMemoryPackageLibrary());
    expect(JSON.parse(published.files["ocs.json"]!).specVersion).toBe("1.1");
    expect(published.draft.manifest.specVersion).toBe("1.1");
  });
});

describe("libraries hold exports", () => {
  it("as immutable versions", async () => {
    const library = new InMemoryPackageLibrary();
    const first = await library.publishExport(text(wordBuilders()));
    expect(await library.publishExport(JSON.stringify(wordBuilders()))).toStrictEqual({ ...first, text: text(wordBuilders()) });
    await expect(library.publishExport(text(wordBuilders({ language: "es" })))).rejects.toMatchObject({ code: "conflict" });
    expect(await library.listExportVersions("openbio.example/word-builders")).toStrictEqual(["1.0.0"]);
    expect(await library.getExport("openbio.example/word-builders", "2.0.0")).toBeUndefined();
  });
});

async function composed() {
  const { library, ref } = await publishedExport();
  const root = await readPackage(await portableCourse(ref));
  return { library, ref, course: composeCourse(await resolveCourse(root, library)) };
}

describe("installing a course with portable activities", () => {
  it("resolves exports by reference and refuses missing, substituted or tampered ones", async () => {
    const { library, ref, course } = await composed();
    const exports = await resolveActivityExports(course, library);
    expect([...exports.keys()]).toStrictEqual([`${ref.id}@${ref.version}`]);
    await rejectsWithProblem(resolveActivityExports(course, new InMemoryPackageLibrary()), "unknown-export");
    const tampered = { listExportVersions: library.listExportVersions.bind(library), getExport: async () => ({ text: text(wordBuilders({ language: "es" })), digest: ref.digest }) };
    await rejectsWithProblem(resolveActivityExports(course, tampered), "export-mismatch", /recorded when it was published/);
    const other = await new InMemoryPackageLibrary().publishExport(text(wordBuilders({ language: "es" })));
    const substituted = { listExportVersions: async () => ["1.0.0"], getExport: async () => other };
    await rejectsWithProblem(resolveActivityExports(course, substituted), "export-mismatch", /not the content the course names/);
  });

  it("plans units, pages, teacher notes and one import per export, and installs through the target", async () => {
    const { library, ref, course } = await composed();
    const plan = planCourseInstall(course, await resolveActivityExports(course, library));
    const key = `${ref.id}@${ref.version}`;
    expect(plan.imports.map((i) => [i.key, i.firstItemKey])).toStrictEqual([[key, "sounds#builders"]]);
    expect(plan.units.map((u) => [u.title, u.items.map((i) => i.kind)])).toStrictEqual([["Short Vowel Sounds", ["page", "activity", "teacher-note"]]]);

    const target = new InMemoryCourseInstallTarget({ catalog: [RF13.competencyUri, RL12.competencyUri] });
    const record = await applyInstallPlan(plan, target, { publishDrafts: true });
    expect(record.mappings).toMatchObject([{ key, status: "published" }]);
    expect(record.pending).toStrictEqual([]);
    expect(target.modules).toMatchObject([{ title: "Short Vowel Sounds", items: [{ kind: "page", title: "Sounds We Know" }, { kind: "activity", title: "Word Builders" }, { kind: "teacher-note", purpose: "answer-key" }] }]);
    const definition = target.definitions.get(record.mappings[0]!.definition.definitionId)!;
    expect(definition.content.evidence.alignments).toStrictEqual([RF13]);
    expect(definition.content.resources).toHaveLength(1);

    // planInstallations takes the recorded mapping for the portable activity, and refuses without one.
    const imported = new Map(record.mappings.map((m) => [m.key, m.definition]));
    expect(planInstallations(course, OFFERING, imported).map((p) => p.input.definitionId)).toStrictEqual([record.mappings[0]!.definition.definitionId]);
    expect(() => planInstallations(course, OFFERING)).toThrow(/has not been imported/);
  });

  it("leaves drafts for review, then installs them from the recorded mappings", async () => {
    const { library, course } = await composed();
    const plan = planCourseInstall(course, await resolveActivityExports(course, library));
    const target = new InMemoryCourseInstallTarget();
    const mappings = await importPlannedActivities(plan, target, { publishDrafts: false });
    expect(mappings).toMatchObject([{ status: "draft" }]);
    const pending = await applyInstallPlan(plan, new InMemoryCourseInstallTarget(), { publishDrafts: false });
    expect(pending.pending).toStrictEqual([{ itemKey: "sounds#builders", importKey: plan.imports[0]!.key }]);

    const reviewed = await importPlannedActivities(plan, target, { mappings, publishDrafts: true });
    expect(reviewed).toMatchObject([{ status: "published", definition: mappings[0]!.definition }]);
    expect(target.definitions.size).toBe(1);
    const record = await applyInstallPlan(plan, target, { mappings: reviewed, publishDrafts: false });
    expect(record.installed.map((i) => i.itemKey)).toStrictEqual(["sounds#builders"]);
    await expect(importPlannedActivities(plan, target, { mappings: [{ ...reviewed[0]!, ref: { ...reviewed[0]!.ref, digest: `sha256:${"0".repeat(64)}` } }], publishDrafts: true })).rejects.toMatchObject({ code: "conflict" });
  });

  it("skips units a district already teaches, with their imports, and refuses goals outside its catalog", async () => {
    const { library, course } = await composed();
    const plan = planCourseInstall(course, await resolveActivityExports(course, library));
    const target = new InMemoryCourseInstallTarget();
    const record = await applyInstallPlan(plan, target, { publishDrafts: true, skipUnit: (u) => u.title === "Short Vowel Sounds" });
    expect(record).toMatchObject({ skippedUnits: ["sounds"], modules: [], mappings: [] });
    expect(target.definitions.size).toBe(0);
    await expect(applyInstallPlan(plan, new InMemoryCourseInstallTarget({ catalog: [RL12.competencyUri] }), { publishDrafts: true })).rejects.toMatchObject({ code: "validation-failed" });
  });

  it("refuses a plan whose exports are missing", async () => {
    const { course } = await composed();
    expect(() => planCourseInstall(course, new Map())).toThrow(/is not available/);
  });
});
