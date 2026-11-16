// The educateos.io course catalog (SCHO-333): every course under curriculum/ has a page, every
// signed course file it links is served as committed, and no teacher-only text is ever published.
// Run: node --test sites/educateos-io/catalog.test.mjs

import assert from "node:assert/strict";
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {bandOf, CATALOG_DIR, courseModel, esc, gradeLabel, renderCatalog, renderCatalogFiles, RFC_URL} from "./catalog.mjs";

const curriculum = fileURLToPath(new URL("../../curriculum/", import.meta.url));
const site = fileURLToPath(new URL("./", import.meta.url));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const isDir = (path) => statSync(path).isDirectory();
const walk = (dir) => readdirSync(dir).flatMap((name) => (isDir(join(dir, name)) ? walk(join(dir, name)) : [join(dir, name)]));

// Read straight from disk, independently of the generator: one entry per OCS package directory.
const courses = readdirSync(curriculum)
  .filter((domain) => domain !== "bundles" && isDir(join(curriculum, domain)))
  .flatMap((domain) => readdirSync(join(curriculum, domain))
    .filter((name) => name !== "activities" && isDir(join(curriculum, domain, name)))
    .map((name) => ({domain, name, dir: join(curriculum, domain, name)})));
const bundles = walk(join(curriculum, "bundles")).filter((file) => file.endsWith(".json"));

const files = await renderCatalog();
const pages = [...files].filter(([path]) => path.endsWith(".html"));
const publicText = [...files].filter(([path]) => !/\/\d+\.\d+\.\d+\.json$/.test(path));
const text = (html) => html.replace(/<[^>]+>/g, " ");

test("there are courses to list", () => {
  assert.ok(courses.length >= 1);
  assert.ok(files.has(`${CATALOG_DIR}/index.html`));
});

test("every course under curriculum/ has a page, linked from the index, with every unit in order", () => {
  const index = files.get(`${CATALOG_DIR}/index.html`);
  for (const {domain, name, dir} of courses) {
    const manifest = json(join(dir, "ocs.json"));
    const page = files.get(`${CATALOG_DIR}/${name}/index.html`);
    assert.ok(page, `${domain}/${name} has no page at /${CATALOG_DIR}/${name}/`);
    assert.ok(index.includes(`href="/${CATALOG_DIR}/${name}/"`), `the index does not link ${domain}/${name}`);
    assert.ok(page.includes(`<h1 class="rise" style="--d:1">${esc(manifest.title)}</h1>`), `${name}'s page names its title`);
    let from = 0;
    for (const {unit} of manifest.outline.filter((entry) => entry.kind === "unit")) {
      const title = esc(json(join(dir, "units", `${unit}.json`)).title);
      const at = page.indexOf(`">${title}</h3>`, from);
      assert.ok(at > from, `${name}'s page lists unit ${unit} (${title}) in outline order`);
      from = at;
    }
  }
});

test("each course page links its current signed file, served byte for byte, with its digest and signing key", () => {
  for (const {domain, name, dir} of courses) {
    const {version} = json(join(dir, "ocs.json"));
    const committed = readFileSync(join(curriculum, "bundles", domain, name, `${version}.json`), "utf8");
    const bundle = JSON.parse(committed);
    const page = files.get(`${CATALOG_DIR}/${name}/index.html`);
    const href = `/${CATALOG_DIR}/${name}/${version}.json`;
    assert.ok(page.includes(`href="${href}" download`), `${name}'s page links ${href}`);
    assert.equal(files.get(href.slice(1)), committed, `${href} is the committed bundle`);
    assert.ok(page.includes(bundle.course.digest), `${name}'s page shows the course digest`);
    assert.ok(page.includes(bundle.packages[0].signature.keyId), `${name}'s page shows the signing key`);
  }
});

test("every link to a course file on a catalog page resolves, and every committed bundle is served", () => {
  for (const [path, html] of pages) {
    for (const [, href] of html.matchAll(/href="(\/courses\/[^"]+\.json)"/g)) assert.ok(files.has(href.slice(1)), `${path} links ${href}, which is not served`);
  }
  for (const file of bundles) {
    const bundle = json(file);
    const name = bundle.course.id.slice(bundle.course.id.indexOf("/") + 1);
    assert.equal(files.get(`${CATALOG_DIR}/${name}/${bundle.course.version}.json`), readFileSync(file, "utf8"), `${file} is served`);
  }
});

test("index.json lists every course with its page and signed file", () => {
  const index = JSON.parse(files.get(`${CATALOG_DIR}/index.json`));
  assert.deepEqual(index.courses.map((c) => c.id).toSorted(), courses.map(({domain, name}) => `${domain}/${name}`).toSorted());
  for (const entry of index.courses) {
    assert.ok(files.has(entry.page.slice(1) + "index.html"));
    assert.ok(files.has(entry.bundle.slice(1)));
  }
});

/** Every string value in a parsed JSON document. */
function strings(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** The shared activity a course activity's `portable.id` (`<publisher>/<name>`) names. */
function portable(id) {
  const slash = id.indexOf("/");
  return json(join(curriculum, id.slice(0, slash), "activities", `${id.slice(slash + 1)}.json`));
}

test("no teacher guide or answer key text appears on any catalog page", () => {
  for (const {name, dir} of courses) {
    const notes = readdirSync(join(dir, "codex")).map((file) => json(join(dir, "codex", file)));
    const teacherOnly = notes.filter((note) => note.visibility === "teacher-only");
    assert.ok(teacherOnly.length > 0, `${name} has teacher-only notes to check`);
    // Text a student may see anyway (overviews, the activities' own wording) is not a leak.
    // Parsed strings, not raw JSON, so a title with quotes matches the answer key heading that repeats it.
    const studentText = [
      ...notes.filter((note) => note.visibility !== "teacher-only").map((note) => note.body),
      ...readdirSync(join(dir, "activities")).map((file) => json(join(dir, "activities", file))).flatMap((activity) => [
        ...strings(activity),
        ...(activity.definition.portable?.id ? strings(portable(activity.definition.portable.id)) : []),
      ]),
    ].join("\n");
    for (const note of teacherOnly) {
      const fragments = note.body.split(/\n+/).map((line) => line.replace(/^[-\s]+/, "").trim()).filter((line) => line.length >= 20 && !studentText.includes(line));
      assert.ok(fragments.length > 0, `${name}/${note.id} has text to check`);
      for (const [path, content] of publicText) {
        for (const fragment of fragments) {
          assert.ok(!content.includes(fragment) && !content.includes(esc(fragment)) && !text(content).includes(esc(fragment)), `${path} publishes teacher-only text from ${name}/${note.id}: "${fragment}"`);
        }
        assert.ok(!content.includes(esc(note.title)), `${path} names teacher-only note ${name}/${note.id}`);
      }
    }
  }
});

/** A plan as `planBundleInstall` returns it, with markers in every teacher-only field. */
function syntheticCourse() {
  const plan = {
    course: {packageId: "example.org/sample", version: "1.0.0"},
    imports: [{key: "example.org/sample-a@1.0.0", export: {activity: {template: "problem-set", overview: "STUDENT-ACTIVITY-OVERVIEW"}, alignments: [{frameworkKey: "ccss-math", competencyUri: "urn:educateos:catalog:ccss-math:CCSS.MATH.CONTENT.4.NF.A.1"}]}}],
    units: [{
      unitId: "fractions",
      title: "Fractions <script>alert(1)</script>",
      summary: "STUDENT-UNIT-SUMMARY",
      standards: [],
      items: [
        {kind: "page", title: "Overview", body: "STUDENT-OVERVIEW-BODY"},
        {kind: "teacher-note", purpose: "context", title: "TEACHER-GUIDE-TITLE", body: "TEACHER-GUIDE-BODY"},
        {kind: "activity", role: "assessment", title: "Fraction check", definition: {kind: "portable", importKey: "example.org/sample-a@1.0.0"}},
        {kind: "teacher-note", purpose: "answer-key", title: "ANSWER-KEY-TITLE", body: "ANSWER-KEY-BODY"},
      ],
    }],
    repeated: [],
  };
  const manifest = {id: "example.org/sample", version: "1.0.0", title: "Sample", summary: "A sample.", subject: "mathematics", gradeBand: "4", standards: []};
  return courseModel({
    plan,
    manifest,
    standards: new Map([["urn:educateos:catalog:ccss-math:CCSS.MATH.CONTENT.4.NF.A.1", {code: "4.NF.A.1", statement: "Explain why a fraction a/b is equivalent."}]]),
    bundle: {text: "{}", digest: "sha256:00", keyId: "ed25519-test", publishedAt: "2026-11-04T00:00:00Z"},
  });
}

test("the course model keeps no teacher-only text, and the pages escape course text", () => {
  const course = syntheticCourse();
  const model = JSON.stringify(course);
  for (const marker of ["TEACHER-GUIDE-TITLE", "TEACHER-GUIDE-BODY", "ANSWER-KEY-TITLE", "ANSWER-KEY-BODY"]) assert.ok(!model.includes(marker), `the model holds ${marker}`);
  assert.deepEqual(course.teacherOnly, {guides: 1, answerKeys: 1});
  const page = renderCatalogFiles([course]).get(`${CATALOG_DIR}/sample/index.html`);
  for (const marker of ["STUDENT-OVERVIEW-BODY", "STUDENT-UNIT-SUMMARY", "STUDENT-ACTIVITY-OVERVIEW", "CCSS Math 4.NF.A.1"]) assert.ok(page.includes(marker), `the page shows ${marker}`);
  assert.ok(page.includes("a teacher guide and an answer key"));
  assert.ok(page.includes("The downloadable bundle includes the teacher materials"), "the course page says the bundle carries the teacher materials");
  assert.ok(!page.includes("<script>alert(1)</script>") && page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("courses fall in the index's grade bands by their lowest grade", () => {
  assert.deepEqual(["K", "1", "2", "3-5", "5", "7", "6-8", "8", "9", "9-12", "12"].map((grade) => bandOf(grade).id),
      ["k-2", "k-2", "k-2", "3-5", "3-5", "6-8", "6-8", "6-8", "9-12", "9-12", "9-12"]);
  assert.deepEqual(["K", "1", "3-5", "K-2"].map(gradeLabel), ["Kindergarten", "Grade 1", "Grades 3–5", "Grades K–2"]);
});

test("the site links the catalog, and the catalog links the OCS specification", () => {
  assert.ok(readFileSync(join(site, "partials/header.html"), "utf8").includes('href="/courses/"'));
  assert.ok(readFileSync(join(site, "partials/footer.html"), "utf8").includes('href="/courses/"'));
  assert.ok(readFileSync(join(site, "public/marketplace/index.html"), "utf8").includes('href="/courses/"'));
  for (const [path, html] of pages) assert.ok(html.includes(`href="${RFC_URL}"`), `${path} links the RFC`);
});
