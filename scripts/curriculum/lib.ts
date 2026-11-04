// The in-repo curriculum (SCHO-330): OCS course packages EducateOS publishes, under `curriculum/`,
// and the tooling that validates, packs and signs them. `curriculum/README.md` is the authoring
// guide; this module is what `scripts/curriculum/curriculum.ts` runs.
//
//   curriculum/<domain>/publisher.json              the publisher's public keys (never a private key)
//   curriculum/<domain>/<course>/                   one OCS package, exactly RFC 0001 §3
//   curriculum/<domain>/activities/<name>.json      one portable activity export (OCS 1.1)
//   curriculum/bundles/<domain>/<course>/<v>.json   the signed bundle of each course version
//
// Imported by relative path, like scripts/marketplace does with its packages.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogSeedRelease } from "../../packages/educateos-catalog/src/index.ts";
import { ResourceId, RubricId } from "../../packages/educateos-contracts/src/index.ts";
import { checkActivityContent, generateActivity } from "../../packages/educateos-curriculum/src/index.ts";
import { Ed25519PrivateJwk, type SignedEnvelope, SigningIdentity } from "../../packages/educateos-fleet/src/index.ts";
import { NORTHFIELD_SHOWCASE, type ShowcaseActivity } from "../../packages/educateos-fixtures/src/showcase/index.ts";
// By module, not through the package index, which also loads the Thin CC adapter and its LTI
// dependency: their Web Crypto types are not part of this Node program's library.
import { type ActivityExport, type ParsedActivityExport, readActivityExport, templateInputFor } from "../../packages/educateos-ocs/src/activity-export.ts";
import { buildBundle, OcsBundle, openBundle, serializeBundle } from "../../packages/educateos-ocs/src/bundle.ts";
import { OcsError } from "../../packages/educateos-ocs/src/errors.ts";
import { InMemoryPackageLibrary } from "../../packages/educateos-ocs/src/library.ts";
import { formatJson, LOCK_PATH, type OcsPackage, readPackage } from "../../packages/educateos-ocs/src/package.ts";
import { resolveCourse, serializeLock } from "../../packages/educateos-ocs/src/resolver.ts";
import { isPortable, type OcsActivity } from "../../packages/educateos-ocs/src/schema.ts";
import {
  checkExportPublication,
  checkPublication,
  PublisherTrust,
  signActivityExportPublication,
  signPackagePublication,
} from "../../packages/educateos-ocs/src/signatures.ts";

/** The repository's curriculum directory. */
export const CURRICULUM_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../curriculum");

/** Inside a publisher's directory: where its portable activity exports live. Never a course name. */
export const EXPORTS_DIR = "activities";
/** Inside a publisher's directory: its public keys. */
export const PUBLISHER_FILE = "publisher.json";
/** At the curriculum root: the signed bundles. */
export const BUNDLES_DIR = "bundles";

/** The environment variable a publisher key may be given in: an Ed25519 private JWK as JSON. */
export const PUBLISHER_KEY_ENV = "EDUCATEOS_OCS_PUBLISHER_KEY";
/** The macOS Keychain item holding the educateos.io publisher key (the marketplace listing key). */
export const KEYCHAIN_ITEM = { service: "educateos-marketplace-publisher-key", account: "educateos" } as const;

/** The frameworks the catalog ships records for, so alignments to them can be checked offline. */
export const BUILT_IN_FRAMEWORKS = ["ccss-ela", "ccss-math", "c3", "casel-5", "head-start-elof"] as const;

/** The catalog item types an activity can align to: standards and their parts, never a grouping. */
export const ALIGNABLE_ITEM_TYPES: ReadonlySet<string> = new Set(["Standard", "Component", "Indicator", "Goal"]);

/**
 * Courses whose first units are the Northfield showcase's modules (SCHO-322), by course ID: the
 * showcase offering they must match. A district that already teaches the showcase class then
 * installs only the units after them.
 */
export const SHOWCASE_ORIGINS: Readonly<Record<string, string>> = {
  "educateos.io/grade-1-reading-foundations": "off_nf-g1read-fall-r7",
  "educateos.io/mathematics-7": "off_nf-math7-fall-p1",
  "educateos.io/english-8": "off_nf-eng8-fall-p2",
};

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const IGNORED = new Set([".DS_Store"]);

/** One problem the tooling found. Errors fail `check`; warnings are shown. */
export interface Issue {
  severity: "error" | "warning";
  /** The command that fixes it, when one does: `pack` rewrites digests, lockfiles and bundles; `sign` signs. */
  fix?: "pack" | "sign";
  /** The file, relative to the curriculum root, and the field if there is one. */
  where: string;
  message: string;
}

/** One course package directory. */
export interface CourseDir {
  domain: string;
  name: string;
  /** `<domain>/<name>`, which the manifest's ID must be. */
  id: string;
  /** The package files, by package path. */
  files: Record<string, string>;
}

/** One export file. */
export interface ExportFile {
  domain: string;
  name: string;
  /** `<domain>/<name>`, which the export's ID must be. */
  id: string;
  /** Relative to the curriculum root. */
  path: string;
  text: string;
}

/** The curriculum directory as read from disk. */
export interface CurriculumTree {
  root: string;
  courses: CourseDir[];
  exports: ExportFile[];
  /** Bundle files by path relative to the root. */
  bundles: Map<string, string>;
  /** Each publisher domain's approved keys, from its `publisher.json`. */
  trust: PublisherTrust;
  issues: Issue[];
}

const error = (where: string, message: string): Issue => ({ severity: "error", where, message });
const warning = (where: string, message: string): Issue => ({ severity: "warning", where, message });
const posix = (path: string) => path.split(sep).join("/");
const isDir = (path: string) => statSync(path).isDirectory();
const list = (dir: string) => readdirSync(dir).filter((name) => !IGNORED.has(name)).toSorted();

function walk(dir: string, base = dir): string[] {
  return list(dir).flatMap((name) => {
    const path = join(dir, name);
    return isDir(path) ? walk(path, base) : [posix(relative(base, path))];
  });
}

/** Reads the curriculum directory: every course, export, bundle and publisher key file. */
export function readTree(root: string = CURRICULUM_ROOT): CurriculumTree {
  const tree: CurriculumTree = { root, courses: [], exports: [], bundles: new Map(), trust: { localDomains: [], publishers: [] }, issues: [] };
  if (!existsSync(root)) return tree;
  for (const entry of list(root)) {
    const path = join(root, entry);
    if (entry === "README.md" && !isDir(path)) continue;
    if (entry === BUNDLES_DIR && isDir(path)) {
      for (const file of walk(path)) tree.bundles.set(`${BUNDLES_DIR}/${file}`, readFileSync(join(path, file), "utf8"));
      continue;
    }
    if (!DOMAIN.test(entry) || !isDir(path)) {
      tree.issues.push(error(entry, "is not part of the curriculum layout: the root holds README.md, bundles/ and one directory per publisher domain"));
      continue;
    }
    for (const name of list(path)) {
      const child = join(path, name);
      const where = `${entry}/${name}`;
      if (name === PUBLISHER_FILE && !isDir(child)) {
        try {
          const parsed = PublisherTrust.shape.publishers.element.parse(JSON.parse(readFileSync(child, "utf8")));
          if (parsed.domain !== entry) tree.issues.push(error(where, `names ${parsed.domain}, not ${entry}`));
          else tree.trust.publishers.push(parsed);
        } catch {
          tree.issues.push(error(where, "is not { domain, keys: [{ keyId, publicKey }] }"));
        }
      } else if (name === EXPORTS_DIR && isDir(child)) {
        for (const file of list(child)) {
          const exportPath = `${where}/${file}`;
          const match = /^(.+)\.json$/.exec(file);
          if (match === null || !NAME.test(match[1]!) || isDir(join(child, file))) {
            tree.issues.push(error(exportPath, "is not an export: activities/ holds only <name>.json files, with kebab-case names"));
            continue;
          }
          tree.exports.push({ domain: entry, name: match[1]!, id: `${entry}/${match[1]}`, path: exportPath, text: readFileSync(join(child, file), "utf8") });
        }
      } else if (NAME.test(name) && isDir(child)) {
        const files = Object.fromEntries(walk(child).map((file) => [file, readFileSync(join(child, file), "utf8")]));
        tree.courses.push({ domain: entry, name, id: `${entry}/${name}`, files });
      } else {
        tree.issues.push(error(where, `is not part of the curriculum layout: a publisher directory holds ${PUBLISHER_FILE}, ${EXPORTS_DIR}/ and course directories with kebab-case names`));
      }
    }
  }
  return tree;
}

/** One built-in catalog item. */
export interface CatalogItem {
  frameworkKey: string;
  code: string;
  uri: string;
  itemType: string;
  statement: string;
}

const catalogCache = new Map<string, Promise<Map<string, CatalogItem>>>();

/** The items of a built-in framework release, by competency URI. */
export function catalogItems(frameworkKey: string): Promise<Map<string, CatalogItem>> {
  let cached = catalogCache.get(frameworkKey);
  if (cached === undefined) {
    cached = catalogSeedRelease(frameworkKey).then((release) => {
      const nodes = (release.content as { nodes: { uri: string; humanCodingScheme?: string; itemType?: string; fullStatement?: string }[] }).nodes;
      return new Map(nodes.map((node) => [node.uri, {
        frameworkKey,
        code: node.humanCodingScheme ?? "",
        uri: node.uri,
        itemType: node.itemType ?? "",
        statement: node.fullStatement ?? "",
      }]));
    });
    catalogCache.set(frameworkKey, cached);
  }
  return cached;
}

async function checkAlignment(alignment: { frameworkKey: string; competencyUri: string }, where: string, issues: Issue[]): Promise<void> {
  if (!(BUILT_IN_FRAMEWORKS as readonly string[]).includes(alignment.frameworkKey)) {
    issues.push(error(where, `${alignment.frameworkKey} is not a built-in framework (${BUILT_IN_FRAMEWORKS.join(", ")})`));
    return;
  }
  const item = (await catalogItems(alignment.frameworkKey)).get(alignment.competencyUri);
  if (item === undefined) issues.push(error(where, `${alignment.competencyUri} is not in the built-in ${alignment.frameworkKey} release; find real URIs with \`node scripts/curriculum/curriculum.ts standards ${alignment.frameworkKey} <code prefix>\``));
  else if (!ALIGNABLE_ITEM_TYPES.has(item.itemType)) issues.push(error(where, `${alignment.competencyUri} is a ${item.itemType.toLowerCase()}, not a standard`));
}

const problemIssues = (where: string, caught: unknown): Issue[] => {
  if (caught instanceof OcsError && (caught.problem.kind === "invalid-package" || caught.problem.kind === "invalid-export")) {
    return caught.problem.issues.map((issue) => error(issue.path === "" || issue.path === "export" ? where : `${where}: ${issue.path}`, issue.message));
  }
  return [error(where, caught instanceof Error ? caught.message : String(caught))];
};

const roles = () => ({ lesson: [] as string[], assignment: [] as string[], assessment: [] as string[] });
const domainOf = (id: string) => id.slice(0, id.indexOf("/"));

/** What one course holds, for the validation report. */
export interface CourseReport {
  id: string;
  version: string;
  title: string;
  units: { id: string; title: string; activities: Record<OcsActivity["role"], string[]>; notes: { students: number; teacher: number; answerKeys: number } }[];
  activities: Record<OcsActivity["role"], number>;
  notes: { students: number; teacher: number; answerKeys: number };
  /** Distinct competencies the course, its units and its activities align to. */
  standards: number;
}

/** The outcome of {@link validateTree}. */
export interface Validation {
  issues: Issue[];
  reports: CourseReport[];
  /** Every export that read cleanly, by ID. */
  exports: Map<string, ParsedActivityExport & { file: ExportFile }>;
  /** Every course package that read cleanly, by ID. */
  packages: Map<string, OcsPackage>;
}

const SHOWCASE_LOCAL = new Set(["key", "standards", "aiHelp", "dueInDays", "rubric", "resources", "work"]);

/** The path of an export's file, relative to the curriculum root. */
export const exportFile = (id: string) => `${id.slice(0, id.indexOf("/"))}/${EXPORTS_DIR}/${id.slice(id.indexOf("/") + 1)}.json`;

/** Checks a course's first units against the showcase class it continues. */
async function checkShowcase(course: CourseDir, pkg: OcsPackage, exports: Validation["exports"], issues: Issue[]): Promise<void> {
  const offeringId = SHOWCASE_ORIGINS[course.id];
  if (offeringId === undefined) return;
  const showcase = NORTHFIELD_SHOWCASE.courses.find((c) => c.offeringId === offeringId);
  if (showcase === undefined) {
    issues.push(error(`${course.id}`, `names showcase offering ${offeringId}, which the showcase does not have`));
    return;
  }
  const units = pkg.manifest.outline.flatMap((entry) => (entry.kind === "unit" ? [pkg.units.get(entry.unit)!] : []));
  for (const [index, module] of showcase.modules.entries()) {
    const unit = units[index];
    const where = `${course.id}/units/${unit?.id ?? "?"}.json`;
    if (unit === undefined || unit.title !== module.title) {
      issues.push(error(where, `unit ${index + 1} must be the showcase module "${module.title}", with the same title`));
      continue;
    }
    const exported = unit.items.flatMap((item) => {
      if (item.kind !== "activity") return [];
      const definition = pkg.activities.get(item.ref)?.definition;
      return definition !== undefined && isPortable(definition) ? [exports.get(definition.portable.id)?.export].filter((e) => e !== undefined) : [];
    });
    for (const placed of module.items.filter((item) => item.kind === "activity")) {
      const activity = showcase.activities.find((a) => a.key === placed.key) as ShowcaseActivity;
      const match = exported.find((e) => e.activity.title === activity.title);
      if (match === undefined) {
        issues.push(error(where, `must hold the showcase activity "${activity.title}"`));
        continue;
      }
      for (const [field, value] of Object.entries(activity)) {
        if (SHOWCASE_LOCAL.has(field)) continue;
        // A showcase problem set holds its answers; an export holds the prompts only (README: answers go in the answer key).
        const expected = field === "problems" ? (value as { prompt: string }[]).map(({ prompt }) => ({ prompt })) : value;
        if (JSON.stringify((match.activity as Record<string, unknown>)[field]) !== JSON.stringify(expected)) {
          issues.push(error(`${exportFile(match.id)}: activity.${field}`, `must equal the showcase activity "${activity.title}"`));
        }
      }
      const aligned = new Set<string>();
      for (const alignment of match.alignments) {
        const item = (await catalogItems(alignment.frameworkKey).catch(() => new Map<string, CatalogItem>())).get(alignment.competencyUri);
        if (item !== undefined) aligned.add(`${alignment.frameworkKey} ${item.code}`);
      }
      for (const { framework, code } of activity.standards) {
        if (!aligned.has(`${framework} ${code}`)) issues.push(error(`${exportFile(match.id)}: alignments`, `must include the showcase's ${framework} ${code}`));
      }
    }
  }
}

const BINDINGS_FOR = (exported: ActivityExport) => ({
  readings: new Map(exported.readings.map((reading, index) => [reading.id, { resourceId: ResourceId.parse(`rsc_check-${index + 1}`), version: "1.0.0" }])),
  rubric: exported.rubric === undefined ? undefined : { rubricId: RubricId.parse("rbr_check"), version: 1 },
});

/**
 * Validates every course and export: each parses under OCS 1.1, IDs match their paths, every
 * portable reference resolves to an export in the tree with the same version and digest, every
 * alignment is a real competency of a built-in framework release, every export makes a valid
 * curriculum activity and every assessment has a rubric, the showcase units match, and every unit
 * meets the authoring bar (`curriculum/README.md`).
 */
export async function validateTree(tree: CurriculumTree): Promise<Validation> {
  const issues: Issue[] = [...tree.issues];
  const exports: Validation["exports"] = new Map();
  for (const file of tree.exports) {
    let parsed: ParsedActivityExport;
    try {
      parsed = await readActivityExport(file.text);
    } catch (caught) {
      issues.push(...problemIssues(file.path, caught));
      continue;
    }
    const { export: exported } = parsed;
    if (exported.id !== file.id) issues.push(error(`${file.path}: id`, `is ${exported.id}, but its file says ${file.id}`));
    for (const [index, alignment] of exported.alignments.entries()) await checkAlignment(alignment, `${file.path}: alignments.${index}`, issues);
    if (exported.alignments.length === 0) issues.push(error(`${file.path}: alignments`, "an activity aligns to at least one standard"));
    for (const [index, criterion] of (exported.rubric?.criteria ?? []).entries()) {
      if (criterion.levels.length < 2) issues.push(error(`${file.path}: rubric.criteria.${index}.levels`, "a criterion needs at least two levels to tell work apart"));
    }
    try {
      const content = generateActivity(templateInputFor(exported, BINDINGS_FOR(exported)));
      for (const issue of checkActivityContent(content)) issues.push(error(`${file.path}: activity`, `${issue.path}: ${issue.message}`));
    } catch (caught) {
      issues.push(error(`${file.path}: activity`, `does not make a valid curriculum activity: ${caught instanceof Error ? caught.message : String(caught)}`));
    }
    exports.set(exported.id, { ...parsed, file });
  }

  const packages: Validation["packages"] = new Map();
  const reports: CourseReport[] = [];
  const used = new Set<string>();
  for (const course of tree.courses) {
    const at = (path: string) => `${course.id}/${path}`;
    let pkg: OcsPackage;
    try {
      pkg = await readPackage(course.files);
    } catch (caught) {
      issues.push(...problemIssues(course.id, caught).map((issue) => ({ ...issue, where: issue.where === course.id ? issue.where : `${course.id}/${issue.where.slice(course.id.length + 2)}` })));
      continue;
    }
    if (pkg.manifest.id !== course.id) issues.push(error(at("ocs.json: id"), `is ${pkg.manifest.id}, but its directory says ${course.id}`));
    packages.set(course.id, pkg);
    const standards = new Set<string>();
    const aligned = (key: string) => standards.add(key);
    for (const [index, alignment] of pkg.manifest.standards.entries()) {
      await checkAlignment(alignment, at(`ocs.json: standards.${index}`), issues);
      aligned(alignment.competencyUri);
    }
    for (const activity of pkg.activities.values()) {
      const where = at(`activities/${activity.id}.json: definition`);
      if (!isPortable(activity.definition)) {
        issues.push(error(where, "a published course uses portable activities only: a definitionId means something only in one district"));
        continue;
      }
      const ref = activity.definition.portable;
      used.add(ref.id);
      const found = exports.get(ref.id);
      if (found === undefined) {
        issues.push(error(where, `there is no export ${ref.id} (expected ${exportFile(ref.id)})`));
        continue;
      }
      if (found.export.version !== ref.version) issues.push(error(where, `names version ${ref.version} of ${ref.id}, but the export is ${found.export.version}`));
      else if (found.digest !== ref.digest) issues.push({ ...error(where, `pins ${ref.digest}, but ${ref.id} ${ref.version} is ${found.digest}; run \`node scripts/curriculum/curriculum.ts pack\``), fix: "pack" });
      if (activity.role === "assessment" && found.export.rubric === undefined) issues.push(error(where, `${ref.id} is an assessment and needs a rubric`));
      for (const alignment of found.export.alignments) aligned(alignment.competencyUri);
      if (!ref.id.slice(ref.id.indexOf("/") + 1).startsWith(`${course.name}-`)) {
        issues.push(warning(where, `exports are named <course>-<activity>; ${ref.id} does not start with ${course.name}-`));
      }
    }

    const report: CourseReport = { id: course.id, version: pkg.manifest.version, title: pkg.manifest.title, units: [], activities: { lesson: 0, assignment: 0, assessment: 0 }, notes: { students: 0, teacher: 0, answerKeys: 0 }, standards: 0 };
    const outlined = pkg.manifest.outline.flatMap((entry) => (entry.kind === "unit" ? [pkg.units.get(entry.unit)!] : []));
    for (const unit of outlined) {
      const where = at(`units/${unit.id}.json`);
      for (const [index, alignment] of unit.standards.entries()) {
        await checkAlignment(alignment, `${where}: standards.${index}`, issues);
        aligned(alignment.competencyUri);
      }
      const unitReport = { id: unit.id, title: unit.title, activities: roles(), notes: { students: 0, teacher: 0, answerKeys: 0 } };
      for (const item of unit.items) {
        if (item.kind === "activity") {
          const activity = pkg.activities.get(item.ref)!;
          unitReport.activities[activity.role].push(activity.title);
          report.activities[activity.role]++;
        } else if (item.kind === "codex") {
          const codex = pkg.codex.get(item.ref)!;
          const kind = codex.purpose === "answer-key" ? "answerKeys" : codex.visibility === "students" ? "students" : "teacher";
          unitReport.notes[kind]++;
          report.notes[kind]++;
        }
      }
      const { activities, notes } = unitReport;
      if (unit.standards.length === 0) issues.push(error(`${where}: standards`, "a unit names the standards it teaches"));
      if (notes.students === 0) issues.push(error(where, "needs a student overview: a Codex note with purpose context and visibility students"));
      if (notes.teacher === 0) issues.push(error(where, "needs a teacher guide: a Codex note with purpose context and visibility teacher-only"));
      if (notes.answerKeys === 0) issues.push(error(where, "needs an answer key: a Codex note with purpose answer-key (always teacher-only)"));
      if (activities.lesson.length === 0) issues.push(error(where, "needs a lesson activity"));
      if (activities.assignment.length === 0) issues.push(error(where, "needs at least one assignment"));
      if (activities.assignment.length > 2) issues.push(warning(where, "has more than two assignments"));
      if (activities.assessment.length === 0) issues.push(error(where, "needs an assessment, with a rubric"));
      report.units.push(unitReport);
    }
    if (outlined.length < 5 || outlined.length > 8) issues.push(warning(at("ocs.json: outline"), `a semester course has about six units; this one has ${outlined.length}`));
    if (pkg.manifest.subject === undefined || pkg.manifest.gradeBand === undefined) issues.push(warning(at("ocs.json"), "name the course's subject and gradeBand"));
    for (const note of pkg.codex.values()) {
      if (!outlined.some((unit) => unit.items.some((item) => item.kind === "codex" && item.ref === note.id))) issues.push(warning(at(`codex/${note.id}.json`), "is not placed in any unit"));
    }
    for (const activity of pkg.activities.values()) {
      if (!outlined.some((unit) => unit.items.some((item) => item.kind === "activity" && item.ref === activity.id))) issues.push(warning(at(`activities/${activity.id}.json`), "is not placed in any unit"));
    }
    report.standards = standards.size;
    reports.push(report);
    await checkShowcase(course, pkg, exports, issues);
  }
  for (const [id, { file }] of exports) if (!used.has(id)) issues.push(warning(file.path, "no course uses this export"));
  return { issues, reports, exports, packages };
}

/** The bundle path of a course version, relative to the curriculum root. */
export const bundlePath = (courseId: string, version: string) => `${BUNDLES_DIR}/${courseId}/${version}.json`;

/** The repository files `pack` writes: the course package files it updates and every current bundle. */
export interface PackOutput {
  /** Contents by path relative to the curriculum root. */
  files: Map<string, string>;
  issues: Issue[];
}

/** Every signature in the tree's bundles, by `package:` or `export:` then `id@version#digest`. */
function signatureIndex(tree: CurriculumTree): Map<string, SignedEnvelope> {
  const index = new Map<string, SignedEnvelope>();
  for (const text of tree.bundles.values()) {
    let bundle: OcsBundle;
    try {
      bundle = OcsBundle.parse(JSON.parse(text));
    } catch {
      continue;
    }
    for (const p of bundle.packages) if (p.signature !== undefined) index.set(`package:${p.id}@${p.version}#${p.digest}`, p.signature);
    for (const e of bundle.exports) if (e.signature !== undefined) index.set(`export:${e.id}@${e.version}#${e.digest}`, e.signature);
  }
  return index;
}

/**
 * What `pack` writes, computed without writing: each course's activity files with every portable
 * digest brought up to date, its lockfile, and its bundle (keeping any signature over the same
 * content). Deterministic: the same tree always gives the same bytes.
 */
export async function packTree(tree: CurriculumTree, validation: Validation): Promise<PackOutput> {
  const files = new Map<string, string>();
  const issues: Issue[] = [];
  const signatures = signatureIndex(tree);

  // 1. Portable digests.
  const updated = new Map<string, Record<string, string>>();
  for (const course of tree.courses) {
    const next = { ...course.files };
    for (const [path, text] of Object.entries(course.files)) {
      if (!path.startsWith("activities/")) continue;
      let activity: OcsActivity;
      try {
        activity = JSON.parse(text) as OcsActivity;
      } catch {
        continue;
      }
      const ref = (activity.definition as { portable?: { id: string; version: string; digest: string } } | undefined)?.portable;
      const found = ref === undefined ? undefined : validation.exports.get(ref.id);
      if (ref === undefined || found === undefined || found.export.version !== ref.version || found.digest === ref.digest) continue;
      next[path] = formatJson({ ...activity, definition: { portable: { ...ref, digest: found.digest } } });
      files.set(`${course.id}/${path}`, next[path]);
    }
    updated.set(course.id, next);
  }

  // 2. Lockfiles, resolved against the tree's own packages.
  const library = new InMemoryPackageLibrary();
  const readable = new Map<string, OcsPackage>();
  for (const course of tree.courses) {
    try {
      const pkg = await readPackage(updated.get(course.id)!);
      await library.publish(updated.get(course.id)!);
      readable.set(course.id, pkg);
    } catch {
      // validateTree reports it.
    }
  }
  for (const course of tree.courses) {
    const pkg = readable.get(course.id);
    if (pkg === undefined) continue;
    let resolution;
    try {
      resolution = await resolveCourse(pkg, library, { locked: pkg.lock });
    } catch (caught) {
      issues.push(error(`${course.id}/ocs.json: modules`, caught instanceof Error ? caught.message : String(caught)));
      continue;
    }
    const lock = serializeLock(resolution.lock);
    const courseFiles = { ...updated.get(course.id)!, [LOCK_PATH]: lock };
    if (course.files[LOCK_PATH] !== lock) files.set(`${course.id}/${LOCK_PATH}`, lock);
    updated.set(course.id, courseFiles);

    // 3. The bundle: the course, the packages it includes, and every export they name.
    const included = [...resolution.packages.values()];
    const named = new Set([pkg, ...included].flatMap((p) => [...p.activities.values()].flatMap((a) => (isPortable(a.definition) ? [a.definition.portable.id] : []))));
    const exports = [...named].flatMap((id) => {
      const found = validation.exports.get(id);
      return found === undefined ? [] : [{ text: found.file.text, signature: signatures.get(`export:${id}@${found.export.version}#${found.digest}`) }];
    });
    const signatureOf = (p: OcsPackage) => signatures.get(`package:${p.manifest.id}@${p.manifest.version}#${p.digest}`);
    try {
      const modules = included.map((p) => ({ files: updated.get(p.manifest.id) ?? {}, signature: signatureOf(p) }));
      const root = await readPackage(courseFiles);
      const bundle = await buildBundle({ course: { files: courseFiles, signature: signatureOf(root) }, modules, exports });
      files.set(bundlePath(course.id, pkg.manifest.version), serializeBundle(bundle));
    } catch (caught) {
      issues.push(...problemIssues(course.id, caught));
    }
  }
  // Only what differs from disk.
  for (const [path, text] of files) {
    const onDisk = tree.bundles.get(path) ?? readIfExists(join(tree.root, path));
    if (onDisk === text) files.delete(path);
  }
  return { files, issues };
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Writes `pack`'s output under the curriculum root. */
export function writeOutput(root: string, files: ReadonlyMap<string, string>): void {
  for (const [path, text] of files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

/**
 * Checks every bundle in the tree: it opens against the publishers' keys in `publisher.json` at
 * `now` (so every part is signed by an approved key and matches its digest), lives at the path its
 * course and version name, and no export or package version appears with two different contents.
 */
export async function checkBundles(tree: CurriculumTree, now: Date): Promise<Issue[]> {
  const issues: Issue[] = [];
  const seen = new Map<string, { digest: string; path: string }>();
  for (const [path, text] of [...tree.bundles].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    let bundle: OcsBundle;
    try {
      bundle = OcsBundle.parse(JSON.parse(text));
    } catch {
      issues.push(error(path, "is not a course bundle"));
      continue;
    }
    if (path !== bundlePath(bundle.course.id, bundle.course.version)) issues.push(error(path, `holds ${bundle.course.id} ${bundle.course.version}, which belongs at ${bundlePath(bundle.course.id, bundle.course.version)}`));
    const unsigned = [...bundle.packages, ...bundle.exports].filter((part) => part.signature === undefined).map((part) => `${part.id} ${part.version}`);
    if (unsigned.length > 0) {
      const listed = unsigned.length > 3 ? `${unsigned.slice(0, 3).join(", ")} and ${unsigned.length - 3} more` : unsigned.join(", ");
      issues.push({ ...error(path, `${unsigned.length} part(s) are not signed (${listed}); run \`node scripts/curriculum/curriculum.ts sign\``), fix: "sign" });
    }
    if ([...bundle.packages, ...bundle.exports].every((part) => part.signature !== undefined)) {
      try {
        await openBundle(bundle, tree.trust, now);
      } catch (caught) {
        issues.push(error(path, caught instanceof Error ? caught.message : String(caught)));
      }
    }
    for (const [kind, parts] of [["package", bundle.packages], ["export", bundle.exports]] as const) {
      for (const part of parts) {
        const key = `${kind} ${part.id} ${part.version}`;
        const earlier = seen.get(key);
        if (earlier !== undefined && earlier.digest !== part.digest) issues.push(error(path, `${key} differs from the one in ${earlier.path}: a published version never changes, so give the new content a new version`));
        if (earlier === undefined) seen.set(key, { digest: part.digest, path });
      }
    }
  }
  return issues;
}

/** What `check` found: validation, staleness and bundle problems. */
export interface CheckResult {
  validation: Validation;
  issues: Issue[];
  /** Files `pack` would change. */
  stale: string[];
}

/** Everything `pnpm curriculum:check` runs: validate, then whether pack is current, then the bundles. */
export async function checkTree(tree: CurriculumTree, now: Date = new Date()): Promise<CheckResult> {
  const validation = await validateTree(tree);
  const packed = await packTree(tree, validation);
  const stale = [...packed.files.keys()].toSorted();
  const issues = [
    ...validation.issues,
    ...packed.issues,
    ...stale.map((path): Issue => ({ ...error(path, "is out of date; run `node scripts/curriculum/curriculum.ts pack` (then `sign`)"), fix: "pack" })),
    ...(stale.length === 0 ? await checkBundles(tree, now) : []),
  ];
  for (const course of tree.courses) {
    const pkg = validation.packages.get(course.id);
    if (pkg !== undefined && !tree.bundles.has(bundlePath(course.id, pkg.manifest.version)) && !stale.includes(bundlePath(course.id, pkg.manifest.version))) {
      issues.push(error(course.id, "has no bundle; run `node scripts/curriculum/curriculum.ts pack`"));
    }
  }
  return { validation, issues, stale };
}

/**
 * Signs every unsigned (or no longer verifying) package and export, in each course's current
 * bundle, that belongs to the key's publisher domain, and returns the bundles to write. Refuses a
 * key its domain's `publisher.json` does not list, and a tree that is invalid or not packed.
 */
export async function signTree(tree: CurriculumTree, identity: SigningIdentity, now: Date = new Date()): Promise<{ files: Map<string, string>; signed: string[] }> {
  const { validation, issues, stale } = await checkTree(tree, now);
  const blocking = issues.filter((issue) => issue.severity === "error" && issue.fix !== "sign" && !/signature was not accepted/.test(issue.message));
  if (stale.length > 0 || blocking.length > 0) throw new Error(`the curriculum is not ready to sign (${blocking.length} error(s), ${stale.length} stale file(s)); run validate and pack first`);
  const publisher = tree.trust.publishers.find((p) => p.keys.some((key) => key.keyId === identity.keyId));
  if (publisher === undefined) throw new Error(`the key ${identity.keyId} is not listed in any curriculum/<domain>/${PUBLISHER_FILE}, so nothing it signs would verify`);
  const publishedAt = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const files = new Map<string, string>();
  const signed: string[] = [];
  for (const course of tree.courses) {
    const pkg = validation.packages.get(course.id);
    if (pkg === undefined) continue;
    const path = bundlePath(course.id, pkg.manifest.version);
    const text = tree.bundles.get(path);
    if (text === undefined) continue;
    const bundle = OcsBundle.parse(JSON.parse(text));
    let changed = false;
    for (const part of bundle.packages) {
      if (domainOf(part.id) !== publisher.domain) continue;
      const target = { manifest: { id: part.id, version: part.version }, digest: part.digest } as Pick<OcsPackage, "manifest" | "digest">;
      if (part.signature !== undefined && (await checkPublication(target, part.signature, tree.trust, now)).ok) continue;
      part.signature = await signPackagePublication(identity, { packageId: part.id, version: part.version, digest: part.digest, publishedAt });
      signed.push(`${part.id} ${part.version}`);
      changed = true;
    }
    for (const part of bundle.exports) {
      if (domainOf(part.id) !== publisher.domain) continue;
      if (part.signature !== undefined && (await checkExportPublication(part, part.signature, tree.trust, now)).ok) continue;
      part.signature = await signActivityExportPublication(identity, { exportId: part.id, version: part.version, digest: part.digest, publishedAt });
      signed.push(`${part.id} ${part.version}`);
      changed = true;
    }
    if (changed) files.set(path, serializeBundle(bundle));
  }
  return { files, signed };
}

/**
 * The publisher key: from {@link PUBLISHER_KEY_ENV}, or else, on macOS, from the Keychain item
 * {@link KEYCHAIN_ITEM}. The value is an Ed25519 private JWK as JSON (or that JSON in base64). It
 * is never printed, and no error quotes it.
 */
export async function publisherKey(env: Record<string, string | undefined> = process.env, keychain: () => string | undefined = readKeychain): Promise<{ identity: SigningIdentity; source: string }> {
  const fromEnv = env[PUBLISHER_KEY_ENV]?.trim();
  const value = fromEnv || keychain()?.trim();
  if (!value) throw new Error(`no publisher key: set ${PUBLISHER_KEY_ENV}, or (on macOS) add the Keychain item ${KEYCHAIN_ITEM.service} for account ${KEYCHAIN_ITEM.account}`);
  const source = fromEnv ? PUBLISHER_KEY_ENV : `Keychain ${KEYCHAIN_ITEM.service}`;
  for (const candidate of [value, Buffer.from(value, "base64").toString("utf8")]) {
    try {
      return { identity: await SigningIdentity.fromJwk(Ed25519PrivateJwk.parse(JSON.parse(candidate))), source };
    } catch {
      // Try the next form.
    }
  }
  throw new Error(`the publisher key from ${source} is not an Ed25519 private JWK ({ kty: "OKP", crv: "Ed25519", x, d })`);
}

function readKeychain(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_ITEM.service, "-a", KEYCHAIN_ITEM.account, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** Built-in catalog items whose code starts with `prefix`, for finding real competency URIs. */
export async function findStandards(frameworkKey: string, prefix = ""): Promise<CatalogItem[]> {
  if (!(BUILT_IN_FRAMEWORKS as readonly string[]).includes(frameworkKey)) throw new Error(`${frameworkKey} is not a built-in framework (${BUILT_IN_FRAMEWORKS.join(", ")})`);
  return [...(await catalogItems(frameworkKey)).values()].filter((item) => item.code !== "" && item.code.startsWith(prefix) && ALIGNABLE_ITEM_TYPES.has(item.itemType));
}

/** A course report as lines of text. */
export function formatReport(report: CourseReport): string[] {
  const lines = [`${report.id} ${report.version}: ${report.title}`];
  lines.push(`  ${report.units.length} units; activities: ${report.activities.lesson} lessons, ${report.activities.assignment} assignments, ${report.activities.assessment} assessments; notes: ${report.notes.students} for students, ${report.notes.teacher} teacher guides, ${report.notes.answerKeys} answer keys; ${report.standards} standards`);
  for (const [index, unit] of report.units.entries()) {
    const byRole = (["lesson", "assignment", "assessment"] as const).map((role) => `${role}: ${unit.activities[role].join(", ") || "none"}`).join("; ");
    lines.push(`  ${index + 1}. ${unit.title} — ${byRole}`);
  }
  return lines;
}
