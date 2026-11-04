// The curriculum tooling (SCHO-330): validation and its refusals, deterministic packing, signing
// with a pinned key, and the check CI runs. Fixtures are built under the OS temp directory; the
// repository's own curriculum is only read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { keyIdFor, SigningIdentity } from "../../packages/educateos-fleet/src/index.ts";
import { openBundle, planBundleInstall } from "../../packages/educateos-ocs/src/bundle.ts";
import { applyInstallPlan, InMemoryCourseInstallTarget } from "../../packages/educateos-ocs/src/install-plan.ts";
import { formatJson } from "../../packages/educateos-ocs/src/package.ts";
import { main } from "./curriculum.ts";
import {
  bundlePath,
  checkTree,
  findStandards,
  type Issue,
  packTree,
  PUBLISHER_KEY_ENV,
  publisherKey,
  readTree,
  signTree,
  validateTree,
  writeOutput,
} from "./lib.ts";

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const RF13 = { frameworkKey: "ccss-ela", competencyUri: "urn:educateos:catalog:ccss-ela:CCSS.ELA-LITERACY.RF.1.3" };
const ZERO = `sha256:${"0".repeat(64)}`;
const COURSE = "example.org/phonics";

function write(root: string, path: string, value: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === "string" ? value : formatJson(value));
}

const exportOf = (name: string, extra: Record<string, unknown> = {}) => ({
  specVersion: "1.1",
  id: `example.org/phonics-${name}`,
  version: "1.0.0",
  language: "en",
  activity: {
    template: "read-and-respond", title: `Activity ${name}`, subject: "english-language-arts", gradeBand: "1", overview: "Listen and answer.",
    aiHelp: "none", due: { kind: "none" }, passage: "The cat sat.", questions: [{ prompt: "Who sat?" }], answerBy: "speaking", sentenceFrames: [],
  },
  rubric: { title: "Rubric", criteria: [{ id: "answers", title: "I answered", levels: [{ id: "not-yet", label: "Not yet", points: 1 }, { id: "got-it", label: "Got it!", points: 3 }] }] },
  alignments: [RF13],
  ...extra,
});

/** A one-unit course that meets the authoring bar, with its exports and an approved key. */
async function fixture(): Promise<{ root: string; identity: SigningIdentity }> {
  const root = mkdtempSync(join(tmpdir(), "curriculum-"));
  temps.push(root);
  const identity = await SigningIdentity.generate();
  write(root, "example.org/publisher.json", { domain: "example.org", keys: [{ keyId: await keyIdFor(identity.publicKey), publicKey: identity.publicKey }] });
  const course = "example.org/phonics";
  write(root, `${course}/ocs.json`, {
    specVersion: "1.1", id: COURSE, version: "1.0.0", title: "Phonics", language: "en", subject: "english-language-arts", gradeBand: "1",
    standards: [RF13], modules: [], outline: [{ kind: "unit", unit: "sounds" }], overrides: [],
  });
  const roles = { lesson: "lesson", task: "assignment", check: "assessment" } as const;
  const items = [{ kind: "codex", ref: "overview" }, { kind: "codex", ref: "guide" }];
  for (const [name, role] of Object.entries(roles)) {
    write(root, `example.org/activities/phonics-${name}.json`, exportOf(name));
    write(root, `${course}/activities/${name}.json`, { id: name, title: `Activity ${name}`, role, definition: { portable: { id: `example.org/phonics-${name}`, version: "1.0.0", digest: ZERO } } });
    items.push({ kind: "activity", ref: name });
  }
  items.push({ kind: "codex", ref: "key" });
  write(root, `${course}/units/sounds.json`, { id: "sounds", title: "Sounds", standards: [RF13], items });
  write(root, `${course}/codex/overview.json`, { id: "overview", title: "Overview", body: "We hear sounds.", purpose: "context", visibility: "students" });
  write(root, `${course}/codex/guide.json`, { id: "guide", title: "Guide", body: "Day 1: sounds.", purpose: "context", visibility: "teacher-only" });
  write(root, `${course}/codex/key.json`, { id: "key", title: "Answer key", body: "The cat.", purpose: "answer-key", visibility: "teacher-only" });
  return { root, identity };
}

const errors = (issues: readonly Issue[]) => issues.filter((issue) => issue.severity === "error");
const messages = (issues: readonly Issue[]) => errors(issues).map((issue) => `${issue.where}: ${issue.message}`).join("\n");

async function packed(root: string): Promise<void> {
  const tree = readTree(root);
  writeOutput(root, (await packTree(tree, await validateTree(tree))).files);
}

describe("validate", () => {
  it("accepts a course that meets the bar, with only digests for pack to fix", async () => {
    const { root } = await fixture();
    const { issues, reports } = await validateTree(readTree(root));
    assert.ok(errors(issues).every((issue) => issue.fix === "pack"), messages(issues));
    assert.equal(errors(issues).length, 3);
    assert.deepEqual(reports[0]!.activities, { lesson: 1, assignment: 1, assessment: 1 });
    assert.deepEqual(reports[0]!.notes, { students: 1, teacher: 1, answerKeys: 1 });
    assert.equal(reports[0]!.standards, 1);
  });

  it("refuses files outside the layout, mismatched IDs, district-local activities and missing exports", async () => {
    const { root } = await fixture();
    write(root, `${COURSE}/scripts/run.js`, "alert(1)");
    write(root, "example.org/activities/phonics-task.json", { ...exportOf("task"), id: "example.org/phonics-other" });
    write(root, `${COURSE}/activities/lesson.json`, { id: "lesson", title: "Lesson", role: "lesson", definition: { definitionId: "adf_local", version: 1 } });
    write(root, "example.org/stray.txt", "x");
    write(root, "loose.json", "{}");
    const text = messages((await validateTree(readTree(root))).issues);
    assert.match(text, /scripts\/run\.js: is not part of the course package layout/);
    await rm(root, `${COURSE}/scripts`);
    const issues = messages((await validateTree(readTree(root))).issues);
    assert.match(issues, /phonics-task\.json: id: is example\.org\/phonics-other/);
    assert.match(issues, /activities\/lesson\.json: definition: a published course uses portable activities only/);
    assert.match(issues, /activities\/task\.json: definition: there is no export example\.org\/phonics-task/);
    assert.match(issues, /example\.org\/stray\.txt: is not part of the curriculum layout/);
    assert.match(issues, /loose\.json: is not part of the curriculum layout/);
  });

  it("checks alignments against the built-in catalog, rubrics, the plain-text rule and the authoring bar", async () => {
    const { root } = await fixture();
    write(root, "example.org/activities/phonics-lesson.json", exportOf("lesson", { alignments: [{ frameworkKey: "ccss-ela", competencyUri: "urn:educateos:catalog:ccss-ela:CCSS.ELA-LITERACY.RF.1.99" }] }));
    write(root, "example.org/activities/phonics-task.json", exportOf("task", { alignments: [{ frameworkKey: "ccss-ela", competencyUri: "urn:educateos:catalog:ccss-ela:CCSS.ELA-LITERACY.RL.1.craft-and-structure" }] }));
    write(root, "example.org/activities/phonics-check.json", exportOf("check", { rubric: undefined, alignments: [{ frameworkKey: "ngss", competencyUri: "urn:x" }] }));
    let text = messages((await validateTree(readTree(root))).issues);
    assert.match(text, /RF\.1\.99 is not in the built-in ccss-ela release/);
    assert.match(text, /craft-and-structure is a heading, not a standard/);
    assert.match(text, /ngss is not a built-in framework/);
    assert.match(text, /phonics-check is an assessment and needs a rubric/);

    const { root: markup } = await fixture();
    write(markup, `${COURSE}/codex/guide.json`, { id: "guide", title: "Guide", body: "<script>alert(1)</script>", purpose: "context", visibility: "teacher-only" });
    assert.match(messages((await validateTree(readTree(markup))).issues), /guide\.json: body: package text is plain text/);

    const { root: second } = await fixture();
    write(second, `${COURSE}/units/sounds.json`, { id: "sounds", title: "Sounds", standards: [], items: [{ kind: "activity", ref: "task" }] });
    text = messages((await validateTree(readTree(second))).issues);
    for (const needed of [/a unit names the standards/, /needs a student overview/, /needs a teacher guide/, /needs an answer key/, /needs a lesson/, /needs an assessment/]) assert.match(text, needed);
  });

  it("refuses a rubric criterion with one level, an export with district-local fields, and an unused export", async () => {
    const { root } = await fixture();
    write(root, "example.org/activities/phonics-task.json", exportOf("task", { rubric: { title: "R", criteria: [{ id: "a", title: "A", levels: [{ id: "x", label: "X", points: 1 }] }] } }));
    write(root, "example.org/activities/phonics-check.json", exportOf("check", { scope: { level: "offering" } }));
    write(root, "example.org/activities/phonics-spare.json", exportOf("spare"));
    const { issues } = await validateTree(readTree(root));
    assert.match(messages(issues), /needs at least two levels/);
    assert.match(messages(issues), /phonics-check\.json: .*[Uu]nrecognized key/);
    assert.ok(issues.some((issue) => issue.severity === "warning" && issue.where.endsWith("phonics-spare.json")));
  });
});

async function rm(root: string, path: string): Promise<void> {
  rmSync(join(root, path), { recursive: true, force: true });
}

describe("pack, sign and check", () => {
  it("pack is deterministic, and check fails until the course is packed and signed", async () => {
    const { root, identity } = await fixture();
    assert.ok((await checkTree(readTree(root))).stale.length > 0);
    await packed(root);
    const first = readFileSync(join(root, bundlePath(COURSE, "1.0.0")), "utf8");
    const again = await packTree(readTree(root), await validateTree(readTree(root)));
    assert.equal(again.files.size, 0);

    let result = await checkTree(readTree(root));
    assert.deepEqual(result.stale, []);
    assert.match(messages(result.issues), /4 part\(s\) are not signed/);

    const { files, signed } = await signTree(readTree(root), identity);
    assert.equal(signed.length, 4);
    writeOutput(root, files);
    result = await checkTree(readTree(root));
    assert.deepEqual(errors(result.issues), [], messages(result.issues));
    assert.equal((await signTree(readTree(root), identity)).signed.length, 0);

    // Packing again keeps every signature, because nothing changed.
    await packed(root);
    assert.deepEqual(errors((await checkTree(readTree(root))).issues), []);
    assert.notEqual(readFileSync(join(root, bundlePath(COURSE, "1.0.0")), "utf8"), first, "the bundle now carries signatures");

    // The bundle installs: it opens against the approved key and plans every activity.
    const trust = readTree(root).trust;
    const opened = await openBundle(JSON.parse(readFileSync(join(root, bundlePath(COURSE, "1.0.0")), "utf8")), trust, new Date());
    const record = await applyInstallPlan(await planBundleInstall(opened), new InMemoryCourseInstallTarget(), { publishDrafts: true });
    assert.equal(record.installed.length, 3);
  });

  it("finds a changed export stale, re-signs only what changed, and refuses a reused version", async () => {
    const { root, identity } = await fixture();
    await packed(root);
    writeOutput(root, (await signTree(readTree(root), identity)).files);
    write(root, "example.org/activities/phonics-task.json", exportOf("task", { language: "es" }));
    const stale = await checkTree(readTree(root));
    assert.ok(stale.stale.includes(`${COURSE}/activities/task.json`));
    assert.ok(stale.stale.includes(bundlePath(COURSE, "1.0.0")));
    await packed(root);
    const { signed } = await signTree(readTree(root), identity);
    assert.deepEqual(signed.toSorted(), [`${COURSE} 1.0.0`, "example.org/phonics-task 1.0.0"]);

    // A bundle of an earlier course version that shipped the export's same version with other content.
    const { root: other, identity: key2 } = await fixture();
    await packed(other);
    writeOutput(other, (await signTree(readTree(other), key2)).files);
    const old = JSON.parse(readFileSync(join(other, bundlePath(COURSE, "1.0.0")), "utf8"));
    write(root, bundlePath(COURSE, "0.9.0"), { ...old, course: { ...old.course, version: "0.9.0" } });
    const text = messages((await checkTree(readTree(root))).issues);
    assert.match(text, /export example\.org\/phonics-task 1\.0\.0 differs from the one in/);
  });

  it("signs only with a key the publisher file lists, and finds tampering", async () => {
    const { root } = await fixture();
    await packed(root);
    await assert.rejects(signTree(readTree(root), await SigningIdentity.generate()), /is not listed in any curriculum/);
    const { root: unpacked, identity } = await fixture();
    await assert.rejects(signTree(readTree(unpacked), identity), /not ready to sign/);

    writeOutput(unpacked, (await packTree(readTree(unpacked), await validateTree(readTree(unpacked)))).files);
    writeOutput(unpacked, (await signTree(readTree(unpacked), identity)).files);
    const path = bundlePath(COURSE, "1.0.0");
    const bundle = JSON.parse(readFileSync(join(unpacked, path), "utf8"));
    bundle.exports[0].signature.signature = bundle.exports[1].signature.signature;
    write(unpacked, path, bundle);
    assert.match(messages((await checkTree(readTree(unpacked))).issues), /signature was not accepted \(bad-signature\)|out of date/);
  });

  it("reads the publisher key from the environment without ever quoting it", async () => {
    const identity = await SigningIdentity.generate();
    const jwk = await identity.exportJwk();
    const fromEnv = await publisherKey({ [PUBLISHER_KEY_ENV]: JSON.stringify(jwk) }, () => undefined);
    assert.equal(fromEnv.identity.keyId, identity.keyId);
    const fromKeychain = await publisherKey({}, () => Buffer.from(JSON.stringify(jwk)).toString("base64"));
    assert.equal(fromKeychain.source, "Keychain educateos-marketplace-publisher-key");
    await assert.rejects(publisherKey({}, () => undefined), /no publisher key/);
    await assert.rejects(publisherKey({ [PUBLISHER_KEY_ENV]: "secret-not-a-key" }, () => undefined), (caught: Error) => !caught.message.includes("secret-not-a-key"));
  });
});

describe("the command line", () => {
  it("validates, packs and checks a tree, and lists real competency URIs", async () => {
    const { root } = await fixture();
    const lines: string[] = [];
    assert.equal(await main(["validate", "--root", root], (line) => lines.push(line)), 1);
    assert.equal(await main(["pack", "--root", root], (line) => lines.push(line)), 0);
    assert.equal(await main(["check", "--root", root], (line) => lines.push(line)), 1);
    assert.ok(lines.some((line) => line.includes("not signed")));
    assert.equal(await main(["nothing"], () => {}), 2);
    const found = await findStandards("ccss-ela", "RF.1.");
    assert.deepEqual(found.map((item) => item.code), ["RF.1.1", "RF.1.2", "RF.1.3", "RF.1.4"]);
  });
});
