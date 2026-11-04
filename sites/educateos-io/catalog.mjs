// The educateos.io course catalog (SCHO-333): a public page for every sample course under
// curriculum/ (SCHO-329), generated from the signed bundles there, so a course appears on the
// site's next deploy once it is merged. Nothing here is hand-maintained.
//
//   /courses/                        every course, by grade band
//   /courses/<name>/                 one course: its outline, what is teacher-only, how to install it
//   /courses/<name>/<version>.json   the signed bundle, byte for byte as committed
//   /courses/index.json              the same list for machines
//
// build.mjs writes these into public/courses/ (gitignored) on every run, and links.test.mjs and
// catalog.test.mjs render them in memory. Each bundle is opened with the publishers' keys in
// curriculum/<domain>/publisher.json first, exactly as a district would open it, so the site lists
// only what verifies, and the outline is read from the install plan, so it is what a district gets.
//
// Teacher-only Codex notes (teacher guides and answer keys) are counted, never printed: the model
// below keeps no teacher-only text at all (catalog.test.mjs).

import {createHash} from "node:crypto";
import {BUNDLES_DIR, bundlePath, catalogItems, CURRICULUM_ROOT, readTree} from "../../scripts/curriculum/lib.ts";
import {openBundle, planBundleInstall} from "../../packages/educateos-ocs/src/bundle.ts";
import {stamp} from "./stamp.mjs";

/** The catalog's directory in public/, and its URL path. */
export const CATALOG_DIR = "courses";

/** The OCS RFC, on the repository's public mirror. */
export const RFC_URL = "https://github.com/gmackie/educate-os/blob/main/docs/educateos/rfc/0001-open-course-specification.md";

/** The index's grade bands, in order, with the lowest and highest grade each holds (K is 0). */
export const GRADE_BANDS = [
  {id: "k-2", label: "Grades K–2", low: 0, high: 2},
  {id: "3-5", label: "Grades 3–5", low: 3, high: 5},
  {id: "6-8", label: "Grades 6–8", low: 6, high: 8},
  {id: "9-12", label: "Grades 9–12", low: 9, high: 12},
];

const SUBJECTS = {
  "english-language-arts": "English language arts",
  "science": "Science",
  "history-social-studies": "History and social studies",
  "mathematics": "Mathematics",
  "arts": "Arts",
  "world-languages": "World languages",
  "computer-science": "Computer science",
  "health-physical-education": "Health and physical education",
  "social-emotional-learning": "Social-emotional learning",
  "other": "Other",
};

const TEMPLATES = {
  "writing-task": "Writing task",
  "science-investigation": "Science investigation",
  "primary-source-analysis": "Primary-source analysis",
  "problem-set": "Problem set",
  "picture-response": "Picture response",
  "read-and-respond": "Read and respond",
};

const FRAMEWORKS = {"ccss-ela": "CCSS ELA", "ccss-math": "CCSS Math", "c3": "C3", "casel-5": "CASEL", "head-start-elof": "ELOF"};

const ROLES = ["lesson", "assignment", "assessment"];
const ROLE_LABELS = {lesson: "Lesson", assignment: "Assignment", assessment: "Assessment"};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const gradeNumber = (grade) => (grade.toUpperCase() === "K" ? 0 : Number(grade));

/** A grade band as `{low, high}`: `K` is 0, `3-5` is 3 to 5. */
export function gradeRange(gradeBand) {
  const [low, high = low] = gradeBand.split("-").map(gradeNumber);
  if (!Number.isInteger(low) || !Number.isInteger(high)) throw new Error(`gradeBand ${gradeBand} is not a grade or a range of grades`);
  return {low, high};
}

/** The index band a course's grades start in. */
export function bandOf(gradeBand) {
  const {low} = gradeRange(gradeBand);
  return GRADE_BANDS.find((band) => low <= band.high) ?? GRADE_BANDS.at(-1);
}

/** `K` reads "Kindergarten", `1` "Grade 1", `3-5` "Grades 3–5". */
export function gradeLabel(gradeBand) {
  const parts = gradeBand.split("-");
  if (parts.length === 1) return gradeBand.toUpperCase() === "K" ? "Kindergarten" : `Grade ${gradeBand}`;
  return `Grades ${parts.join("–")}`;
}

/** A standard's human-readable code, such as "CCSS ELA RF.1.2", from the built-in catalog. */
function standardOf(alignment, items) {
  const item = items.get(alignment.competencyUri);
  const framework = FRAMEWORKS[alignment.frameworkKey] ?? alignment.frameworkKey;
  const code = item?.code || alignment.competencyUri.slice(alignment.competencyUri.lastIndexOf(":") + 1);
  // A standard's lettered parts, "(a) … (b) …", are its components: the stem says what it is.
  const statement = (item?.statement ?? "").replace(/\s*\(a\)[\s\S]*$/, "").trim();
  return {uri: alignment.competencyUri, framework, code, statement};
}

function distinctAlignments(lists) {
  const seen = new Map();
  for (const alignment of lists.flat()) if (!seen.has(alignment.competencyUri)) seen.set(alignment.competencyUri, alignment);
  return [...seen.values()];
}

/** The start of a student overview: whole sentences, up to about 320 characters. */
export function excerpt(body, limit = 320) {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence > limit / 3) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))} …`;
}

/**
 * What the catalog shows of one course: everything public, and of teacher-only notes only how
 * many there are. Pure: it reads the course's install plan and manifest and keeps no teacher-only
 * text, so nothing that renders the model can publish it.
 *
 * @param input.plan the `CourseInstallPlan` of the opened bundle
 * @param input.manifest the course's `ocs.json`
 * @param input.standards built-in catalog items by competency URI
 * @param input.bundle the current version's bundle as committed: `{text, digest, keyId, publishedAt}`
 * @param input.earlier the course's other committed bundles, `{version, text}`, newest first
 */
export function courseModel({plan, manifest, standards, bundle, earlier = []}) {
  const exports = new Map(plan.imports.map((planned) => [planned.key, planned.export]));
  const counts = {lesson: 0, assignment: 0, assessment: 0};
  const teacherOnly = {guides: 0, answerKeys: 0};
  const alignments = [manifest.standards];
  const units = plan.units.map((unit, index) => {
    const activities = [];
    const unitTeacherOnly = {guides: 0, answerKeys: 0};
    const unitAlignments = [unit.standards];
    let overview = null;
    for (const item of unit.items) {
      if (item.kind === "page" && overview === null) overview = {title: item.title, excerpt: excerpt(item.body)};
      if (item.kind === "teacher-note") unitTeacherOnly[item.purpose === "answer-key" ? "answerKeys" : "guides"] += 1;
      if (item.kind !== "activity") continue;
      const exported = item.definition.kind === "portable" ? exports.get(item.definition.importKey) : undefined;
      if (exported !== undefined) unitAlignments.push(exported.alignments);
      counts[item.role] += 1;
      activities.push({
        title: item.title,
        role: item.role,
        template: exported === undefined ? null : TEMPLATES[exported.activity.template] ?? exported.activity.template,
        overview: exported?.activity.overview ?? "",
      });
    }
    teacherOnly.guides += unitTeacherOnly.guides;
    teacherOnly.answerKeys += unitTeacherOnly.answerKeys;
    alignments.push(...unitAlignments);
    return {
      number: index + 1,
      id: unit.unitId,
      title: unit.title,
      summary: unit.summary ?? "",
      overview,
      activities,
      teacherOnly: unitTeacherOnly,
      standards: distinctAlignments(unitAlignments).map((alignment) => standardOf(alignment, standards)),
    };
  });
  const id = manifest.id;
  const name = id.slice(id.indexOf("/") + 1);
  const file = (version) => `${CATALOG_DIR}/${name}/${version}.json`;
  const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  return {
    id,
    name,
    publisher: id.slice(0, id.indexOf("/")),
    version: manifest.version,
    title: manifest.title,
    summary: manifest.summary ?? "",
    subject: SUBJECTS[manifest.subject] ?? manifest.subject,
    gradeBand: manifest.gradeBand,
    grade: gradeLabel(manifest.gradeBand),
    band: bandOf(manifest.gradeBand).id,
    units,
    counts,
    teacherOnly,
    standardsCount: distinctAlignments(alignments).length,
    bundle: {path: file(manifest.version), text: bundle.text, digest: bundle.digest, sha256: sha256(bundle.text), keyId: bundle.keyId, publishedAt: bundle.publishedAt},
    earlier: earlier.map(({version, text}) => ({version, path: file(version), text, sha256: sha256(text)})),
  };
}

const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/**
 * Reads every course under curriculum/: opens its current version's bundle with the publishers'
 * keys and plans its install, as a district would. Throws on a course with no bundle, or a bundle
 * that does not open: `pnpm curriculum:check` fails on both first, so a deploy never meets one.
 */
export async function readCourses({root = CURRICULUM_ROOT, now = new Date()} = {}) {
  const tree = readTree(root);
  const courses = [];
  for (const course of tree.courses) {
    const manifest = JSON.parse(course.files["ocs.json"]);
    const path = bundlePath(course.id, manifest.version);
    const text = tree.bundles.get(path);
    if (text === undefined) throw new Error(`${course.id} ${manifest.version} has no bundle at curriculum/${path}; run node scripts/curriculum/curriculum.ts pack and sign`);
    const bundle = JSON.parse(text);
    const plan = await planBundleInstall(await openBundle(bundle, tree.trust, now));
    const uris = distinctAlignments([manifest.standards, ...plan.units.map((unit) => unit.standards), ...plan.imports.map((planned) => planned.export.alignments)]);
    const standards = new Map();
    for (const key of new Set(uris.map((alignment) => alignment.frameworkKey))) {
      if (!(key in FRAMEWORKS)) continue;
      for (const [uri, item] of await catalogItems(key)) standards.set(uri, item);
    }
    const signature = bundle.packages[0].signature;
    const earlier = [...tree.bundles]
      .filter(([other]) => other !== path && other.startsWith(`${BUNDLES_DIR}/${course.id}/`))
      .map(([, otherText]) => ({version: JSON.parse(otherText).course.version, text: otherText}))
      .toSorted((a, b) => compareVersions(b.version, a.version));
    courses.push(courseModel({
      plan,
      manifest,
      standards,
      bundle: {text, digest: bundle.course.digest, keyId: signature.keyId, publishedAt: signature.payload.publishedAt},
      earlier,
    }));
  }
  const names = new Map();
  for (const course of courses) {
    if (names.has(course.name)) throw new Error(`${course.id} and ${names.get(course.name)} would share /courses/${course.name}/`);
    names.set(course.name, course.id);
  }
  return courses.toSorted((a, b) => gradeRange(a.gradeBand).low - gradeRange(b.gradeBand).low || a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title));
}

// ---- HTML ----

const ESCAPES = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"};
/** Text for HTML: course text is plain text (RFC 0001 §9), and every character is escaped. */
export const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';

function page({path, title, description, body}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · EducateOS</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%23155dfc'/><path d='M9 10h14M9 16h10M9 22h14' stroke='white' stroke-width='3' stroke-linecap='round'/></svg>">
<!-- Kumo design tokens (MIT, see /assets/kumo-LICENSE.txt), the same system the Cloudflare OS Workshop UI uses. -->
<link rel="stylesheet" href="/assets/kumo-2.14.0.css">
<script>
  // Kumo switches themes on [data-mode]; follow the reader's system setting, live.
  (() => {
    const q = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.mode = q.matches ? "dark" : "light"; };
    apply(); q.addEventListener("change", apply);
  })();
</script>
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>

<!-- site:header -->
<!-- /site:header -->

<main class="catalog">
${body}
</main>

<!-- site:footer -->
<!-- /site:footer -->
</body>
</html>
`;
  return stamp(html, path);
}

const activityTotals = (counts) => ROLES.map((role) => plural(counts[role], ROLE_LABELS[role].toLowerCase())).join(", ");

function courseCard(course) {
  return `<article class="gcard course-card">
  <div class="who">${esc(course.grade)} · ${esc(course.subject)}</div>
  <h3><a href="/${CATALOG_DIR}/${esc(course.name)}/">${esc(course.title)}</a></h3>
  <p>${esc(excerpt(course.summary, 200))}</p>
  <dl class="course-facts">
    <div><dt>Units</dt><dd>${course.units.length}</dd></div>
    <div><dt>Activities</dt><dd>${esc(activityTotals(course.counts))}</dd></div>
    <div><dt>Standards</dt><dd>${course.standardsCount}</dd></div>
    <div><dt>Publisher</dt><dd>${esc(course.publisher)} · version ${esc(course.version)}</dd></div>
  </dl>
</article>`;
}

const OCS_COPY = `<p>Every course here is an <b class="strong">Open Course Specification</b> (OCS 1.1) package: an open format, and data only, with no code. A course is its units, activity definitions, Codex notes and the standards they align to, and each part is named by its SHA-256 digest.</p>
        <p>educateos.io signs every course and every activity in it with its publisher key. A district checks those signatures against the publisher keys it has approved before it installs anything, so the file can come from anywhere, and a course moves between districts unchanged.</p>
        <p><a href="${RFC_URL}">Read the OCS specification (RFC 0001)</a></p>`;

function renderIndex(courses) {
  const bands = GRADE_BANDS.map((band) => {
    const inBand = courses.filter((course) => course.band === band.id);
    const cards = inBand.length === 0 ? '<p class="muted">No courses in this band yet.</p>' : `<div class="gallery">\n${inBand.map(courseCard).join("\n")}\n</div>`;
    return `<section class="tight" id="grades-${band.id}" aria-labelledby="grades-${band.id}-title">
    <div class="wrap">
      <div class="eyebrow">${plural(inBand.length, "course")}</div>
      <h2 id="grades-${band.id}-title">${esc(band.label)}</h2>
      ${cards}
    </div>
  </section>`;
  });
  const body = `  <section class="hero page-hero">
    <div class="wrap">
      <div class="eyebrow rise">Course catalog</div>
      <h1 class="rise" style="--d:1">Sample courses, open to read.</h1>
      <p class="lede rise" style="--d:2">${plural(courses.length, "semester-long course")} EducateOS publishes for every district, from kindergarten to high school. Browse each one's full outline here, without signing in. A district installs a course from its signed file.</p>
      <nav class="subnav rise" style="--d:3" aria-label="Grade bands">
        ${GRADE_BANDS.map((band) => `<a href="#grades-${band.id}">${esc(band.label)}</a>`).join("\n        ")}
      </nav>
    </div>
  </section>

  ${bands.join("\n\n  ")}

  <section class="tight band" id="open-course-specification">
    <div class="wrap split top">
      <div class="copy">
        <div class="eyebrow">The format</div>
        <h2>Open, portable, signed.</h2>
        ${OCS_COPY}
      </div>
      <div class="copy">
        <div class="eyebrow">What is not shown</div>
        <h2>Teacher materials stay with teachers.</h2>
        <p>Every unit comes with a teacher guide and an answer key. They install with the course as teacher-only notes, and this site never shows their text.</p>
        <p>The marketplace has <a href="/marketplace/">curriculum packs</a> of single activities, and the <a href="/demo/">demo</a> shows a district running courses like these.</p>
      </div>
    </div>
  </section>`;
  return page({
    path: `/${CATALOG_DIR}/`,
    title: "Course catalog",
    description: "EducateOS's sample courses, K-12: full outlines by unit, the standards they teach, and the signed Open Course Specification files districts install.",
    body,
  });
}

function unitSection(course, unit) {
  const activities = unit.activities.map((activity) => `<li class="activity role-${activity.role}">
            <span class="badge${activity.role === "assessment" ? " orange" : activity.role === "lesson" ? " blue" : ""}">${ROLE_LABELS[activity.role]}</span>
            <span><b class="strong">${esc(activity.title)}</b>${activity.template ? ` <span class="muted">(${esc(activity.template)})</span>` : ""}${activity.overview ? `<br><span class="muted small">${esc(activity.overview)}</span>` : ""}</span>
          </li>`).join("\n          ");
  const standards = unit.standards.map((standard) => `<li><b class="strong">${esc(standard.framework)} ${esc(standard.code)}</b>${standard.statement ? ` <span class="muted">${esc(standard.statement)}</span>` : ""}</li>`).join("\n            ");
  const teacher = [unit.teacherOnly.guides > 0 ? (unit.teacherOnly.guides === 1 ? "a teacher guide" : plural(unit.teacherOnly.guides, "teacher guide")) : "", unit.teacherOnly.answerKeys > 0 ? (unit.teacherOnly.answerKeys === 1 ? "an answer key" : plural(unit.teacherOnly.answerKeys, "answer key")) : ""].filter(Boolean);
  return `<article class="card unit" id="unit-${unit.number}" aria-labelledby="unit-${unit.number}-title">
        <div class="eyebrow">Unit ${unit.number}</div>
        <h3 id="unit-${unit.number}-title">${esc(unit.title)}</h3>
        ${unit.summary ? `<p>${esc(unit.summary)}</p>` : ""}
        ${unit.overview ? `<blockquote class="quote overview"><small>Student overview: ${esc(unit.overview.title)}</small>${esc(unit.overview.excerpt)}</blockquote>` : ""}
        <h4>Activities</h4>
        <ol class="activities">
          ${activities}
        </ol>
        ${unit.standards.length > 0 ? `<h4>Standards</h4>
        <ul class="standards">
          ${standards}
        </ul>` : ""}
        ${teacher.length > 0 ? `<p class="muted small teacher-only">For teachers only, not shown here: ${teacher.join(" and ")}.</p>` : ""}
      </article>`;
}

const sizeOf = (text) => `${Math.max(1, Math.round(Buffer.byteLength(text) / 1024))} KB`;
const formatDate = (iso) => new Date(iso).toLocaleDateString("en-US", {year: "numeric", month: "long", day: "numeric", timeZone: "UTC"});

function renderCourse(course) {
  const assessments = course.units.flatMap((unit) => unit.activities.filter((a) => a.role === "assessment").map((a) => ({unit, activity: a})));
  const earlier = course.earlier.length === 0 ? "" : `<p class="muted small">Earlier versions: ${course.earlier.map((e) => `<a href="/${esc(e.path)}" download>${esc(e.version)}</a>`).join(", ")}</p>`;
  const body = `  <section class="hero page-hero">
    <div class="wrap">
      <div class="eyebrow rise"><a href="/${CATALOG_DIR}/">Course catalog</a> · ${esc(course.grade)} · ${esc(course.subject)}</div>
      <h1 class="rise" style="--d:1">${esc(course.title)}</h1>
      <p class="lede rise" style="--d:2">${esc(course.summary)}</p>
      <div class="facts four rise" style="--d:3">
        <div class="card"><small>Units</small>${course.units.length}</div>
        <div class="card"><small>Activities</small>${esc(activityTotals(course.counts))}</div>
        <div class="card"><small>Standards</small>${course.standardsCount}</div>
        <div class="card"><small>Publisher</small>${esc(course.publisher)} · version ${esc(course.version)}</div>
      </div>
    </div>
  </section>

  <section class="tight" id="outline" aria-labelledby="outline-title">
    <div class="wrap">
      <div class="eyebrow">The outline</div>
      <h2 id="outline-title">${plural(course.units.length, "unit")}, in teaching order.</h2>
      <nav class="subnav" aria-label="Units">
        ${course.units.map((unit) => `<a href="#unit-${unit.number}">${unit.number}. ${esc(unit.title)}</a>`).join("\n        ")}
      </nav>
      <div class="units">
      ${course.units.map((unit) => unitSection(course, unit)).join("\n      ")}
      </div>
    </div>
  </section>

  <section class="tight band" id="assessments" aria-labelledby="assessments-title">
    <div class="wrap split top">
      <div class="copy">
        <div class="eyebrow">Assessments</div>
        <h2 id="assessments-title">${plural(assessments.length, "assessment")}, each with a rubric.</h2>
        <ul class="checks">
          ${assessments.map(({unit, activity}) => `<li>${CHECK}<span><b class="strong">${esc(activity.title)}</b> <span class="muted">Unit ${unit.number}${activity.template ? `, ${esc(activity.template)}` : ""}</span></span></li>`).join("\n          ")}
        </ul>
      </div>
      <div class="copy" id="teacher-only">
        <div class="eyebrow">Teacher-only</div>
        <h2>What students never see.</h2>
        <p>The course includes ${plural(course.teacherOnly.guides, "teacher guide")} and ${plural(course.teacherOnly.answerKeys, "answer key")}. A teacher guide has the unit's objectives by standard, materials, a five-day plan, differentiation for support, stretch and multilingual learners, and a note to send home. An answer key covers every activity in its unit, with a scoring tip.</p>
        <p>They install as teacher-only notes in each unit's module. This page lists that they exist, and never shows their text.</p>
      </div>
    </div>
  </section>

  <section class="tight" id="install" aria-labelledby="install-title">
    <div class="wrap split top">
      <div class="copy">
        <div class="eyebrow">How to install it</div>
        <h2 id="install-title">From the course library to a class.</h2>
        <ol class="install-steps">
          <li><b class="strong">A district administrator imports the bundle</b> into the district's course library. The district checks every digest and every publisher signature against the publisher keys it has approved before it accepts anything.</li>
          <li><b class="strong">A teacher adds the course to a class.</b> Each unit becomes a module, with its student overview as a page, its activities as drafts the teacher can edit before publishing, and its teacher guide and answer key as teacher-only notes.</li>
          <li><b class="strong">Standards map to the district's own catalog.</b> Activities align by standard, so they land on the district's approved frameworks.</li>
        </ol>
        <div class="legend"><span class="status dev">In development</span><span>The bundle format and its verifier are open source today; the district import page comes next.</span></div>
      </div>
      <div class="copy" id="download">
        <div class="eyebrow">Download</div>
        <h2>The signed course file.</h2>
        <p><a class="btn primary" href="/${esc(course.bundle.path)}" download>Download version ${esc(course.version)} (JSON, ${esc(sizeOf(course.bundle.text))})</a></p>
        <dl class="bundle-facts">
          <div><dt>Format</dt><dd><code>educateos.ocs-bundle.v1</code></dd></div>
          <div><dt>Course</dt><dd><code>${esc(course.id)}</code> version ${esc(course.version)}</dd></div>
          <div><dt>Course digest</dt><dd><code>${esc(course.bundle.digest)}</code></dd></div>
          <div><dt>File SHA-256</dt><dd><code>${esc(course.bundle.sha256)}</code></dd></div>
          <div><dt>Signing key</dt><dd><code>${esc(course.bundle.keyId)}</code> (${esc(course.publisher)})</dd></div>
          <div><dt>Signed</dt><dd>${esc(formatDate(course.bundle.publishedAt))}</dd></div>
        </dl>
        ${earlier}
      </div>
    </div>
  </section>

  <section class="tight band" id="open-course-specification">
    <div class="wrap">
      <div class="copy doc">
        <div class="eyebrow">The format</div>
        <h2>Open, portable, signed.</h2>
        ${OCS_COPY}
      </div>
    </div>
  </section>`;
  return page({
    path: `/${CATALOG_DIR}/${course.name}/`,
    title: `${course.title} · Course catalog`,
    description: `${course.grade} ${course.subject}: ${excerpt(course.summary, 150)}`,
    body,
  });
}

/** The machine-readable list: where each course's page and signed file are, and their digests. */
export function catalogIndex(courses) {
  return {
    courses: courses.map((course) => ({
      id: course.id,
      version: course.version,
      title: course.title,
      subject: course.subject,
      gradeBand: course.gradeBand,
      units: course.units.length,
      page: `/${CATALOG_DIR}/${course.name}/`,
      bundle: `/${course.bundle.path}`,
      digest: course.bundle.digest,
      sha256: course.bundle.sha256,
      keyId: course.bundle.keyId,
    })),
  };
}

/** Every catalog file, by its path in public/: the pages, the index and each bundle, as committed. */
export function renderCatalogFiles(courses) {
  const files = new Map([[`${CATALOG_DIR}/index.html`, renderIndex(courses)]]);
  files.set(`${CATALOG_DIR}/index.json`, `${JSON.stringify(catalogIndex(courses), null, 2)}\n`);
  for (const course of courses) {
    files.set(`${CATALOG_DIR}/${course.name}/index.html`, renderCourse(course));
    files.set(course.bundle.path, course.bundle.text);
    for (const version of course.earlier) files.set(version.path, version.text);
  }
  return files;
}

/** Reads curriculum/ and renders the catalog. */
export async function renderCatalog(options) {
  return renderCatalogFiles(await readCourses(options));
}

