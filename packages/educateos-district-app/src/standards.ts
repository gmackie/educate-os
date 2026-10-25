// Learning standards (SCHO-220): the standards releases that ship with EducateOS, a district's
// decision to use them, and the learning goals they offer a class. A district approves a built-in
// release through the catalog mirror, so the goals a teacher picks and the alignments the
// curriculum service accepts are read from the same approved release.
import { EducateOsError, type CatalogCourse, type Subject } from "@educateos/contracts";
import {
  CATALOG,
  CATALOG_VERSION,
  catalogEntry,
  catalogSeedRelease,
  type Actor,
  type CatalogEntry,
  type CatalogMirror,
  type CatalogSubject,
} from "@educateos/catalog";
import type { CompetencyNode, FrameworkRelease } from "@educateos/registry";
import type { LearningGoalBody, LearningGoalsBody, StandardsReleaseBody } from "./routes.ts";

/** The frameworks whose items ship with EducateOS, so a district can approve them without importing anything. */
export const BUILT_IN_STANDARDS: readonly CatalogEntry[] = CATALOG.filter((entry) => entry.status === "available");

const builtIn = (frameworkKey: string): CatalogEntry => {
  const entry = BUILT_IN_STANDARDS.find((e) => e.key === frameworkKey);
  if (entry === undefined) {
    catalogEntry(frameworkKey); // `not-found` for a framework the catalog does not have at all.
    throw new EducateOsError("conflict", "EducateOS does not ship this framework's standards; they have to be imported from their publisher.");
  }
  return entry;
};

/** The listing entry for a built-in framework, from the district's mirror state. */
async function listing(catalog: CatalogMirror, entry: CatalogEntry): Promise<StandardsReleaseBody> {
  const releases = (await catalog.get(entry.key))?.releases ?? [];
  const approved = releases.find((r) => r.status === "approved");
  const latest = releases.filter((r) => r.decidedAt !== undefined).toSorted((a, b) => a.decidedAt!.localeCompare(b.decidedAt!)).at(-1);
  const { name, termsUrl, attribution } = entry.license;
  return {
    frameworkKey: entry.key,
    title: entry.framework.title,
    publisher: entry.framework.publisher ?? entry.framework.creator,
    subjects: [...entry.subjects],
    gradeBands: [...new Set(entry.coverage.filter((row) => row.state === "items" || row.state === "items-without-text").map((row) => row.band))],
    version: approved?.release.version ?? CATALOG_VERSION,
    license: { name, termsUrl, ...(attribution === undefined ? {} : { attribution }) },
    status: approved === undefined ? "not-approved" : "approved",
    ...(latest?.decidedBy === undefined || latest.decidedAt === undefined ? {} : { decided: { by: latest.decidedBy, at: latest.decidedAt } }),
  };
}

/** Every built-in framework, with whether the district approved it. */
export async function listStandards(catalog: CatalogMirror): Promise<StandardsReleaseBody[]> {
  return Promise.all(BUILT_IN_STANDARDS.map((entry) => listing(catalog, entry)));
}

/**
 * Approves a framework's built-in release for the district: selects the framework, installs the
 * release EducateOS ships (verified byte for byte by the mirror), and approves it, retiring any other
 * release in use. Approving a release already in use changes nothing.
 *
 * @throws EducateOsError `not-found` for a framework not in the catalog, and `conflict` for one whose
 *   items EducateOS does not ship.
 */
export async function approveStandards(catalog: CatalogMirror, frameworkKey: string, actor: Actor): Promise<StandardsReleaseBody> {
  const entry = builtIn(frameworkKey);
  const release = await catalogSeedRelease(entry.key);
  await catalog.select(entry.key, actor);
  if ((await catalog.approvedRelease(entry.key))?.contentDigest !== release.contentDigest) {
    await catalog.install(release, actor);
    await catalog.approve(entry.key, release.version, actor);
  }
  return listing(catalog, entry);
}

/**
 * Withdraws the district's approval of a framework's release. Activities already aligned to it keep
 * their recorded alignments; new and revised activities can no longer choose its items.
 *
 * @throws EducateOsError `conflict` if the district has no approved release of it.
 */
export async function withdrawStandards(catalog: CatalogMirror, frameworkKey: string, actor: Actor): Promise<StandardsReleaseBody> {
  const entry = builtIn(frameworkKey);
  const approved = await catalog.approvedRelease(entry.key);
  if (approved === undefined) throw new EducateOsError("conflict", "These standards are not approved for the district.");
  await catalog.retire(entry.key, approved.version, actor);
  return listing(catalog, entry);
}

/** The catalog subject a course subject is reported under, if the catalog covers it. */
const CATALOG_SUBJECT: Partial<Record<Subject, CatalogSubject>> = {
  "english-language-arts": "english-language-arts",
  "mathematics": "mathematics",
  "science": "science",
  "history-social-studies": "social-studies",
  "social-emotional-learning": "social-emotional-learning",
};

/**
 * The CEDS education levels (`KG`, `01` … `12`) a course grade band such as `K`, `7` or `9-12`
 * spans, or undefined for one this cannot read.
 */
export function educationLevelsOf(gradeBand: string): Set<string> | undefined {
  const grade = (part: string | undefined) => (part === "K" ? 0 : part === undefined ? undefined : Number(part));
  const [from, to = from] = gradeBand.split("-");
  const low = grade(from), high = grade(to);
  if (low === undefined || high === undefined || !Number.isInteger(low) || !Number.isInteger(high) || low > high || high > 12) return undefined;
  const levels = new Set<string>();
  for (let g = low; g <= high; g++) levels.add(g === 0 ? "KG" : String(g).padStart(2, "0"));
  return levels;
}

/**
 * The items of a release a teacher can sensibly align an activity to: those with a code and text
 * that do not themselves group groups. A strand or domain (a parent of parents) is too broad; a
 * standard is offered alongside its components.
 */
function choosableNodes(release: FrameworkRelease): CompetencyNode[] {
  const parentOf = new Map<string, string[]>();
  for (const association of release.associations ?? []) {
    if (association.relation !== "child-of") continue;
    const children = parentOf.get(association.destination.uri) ?? [];
    children.push(association.origin.uri);
    parentOf.set(association.destination.uri, children);
  }
  const groupsGroups = (uri: string) => (parentOf.get(uri) ?? []).some((child) => parentOf.has(child));
  return (release.nodes ?? []).filter((node) => node.humanCodingScheme !== undefined && node.fullStatement.trim() !== "" && !groupsGroups(node.uri));
}

/**
 * The learning goals offered for a course: items of every approved release whose framework covers
 * the course's subject, at a grade the course spans. Items the district hid are left out, and a
 * district label replaces the publisher's code. A course whose grade band cannot be read is offered
 * every grade's items.
 */
export async function learningGoalsFor(catalog: CatalogMirror, course: Pick<CatalogCourse, "subject" | "gradeBand">): Promise<LearningGoalsBody> {
  const subject = CATALOG_SUBJECT[course.subject];
  const levels = educationLevelsOf(course.gradeBand);
  const goals: LearningGoalBody[] = [];
  let approvedReleases = 0;
  for (const state of await catalog.selections()) {
    const approved = state.releases.find((r) => r.status === "approved");
    if (approved === undefined) continue;
    approvedReleases++;
    const entry = CATALOG.find((e) => e.key === state.frameworkKey);
    if (subject === undefined || entry === undefined || !entry.subjects.includes(subject)) continue;
    const overlays = new Map(state.overlays.map((overlay) => [overlay.nodeUri, overlay]));
    for (const node of choosableNodes(approved.release.content)) {
      const overlay = overlays.get(node.uri);
      if (overlay?.hidden === true) continue;
      if (levels !== undefined && node.educationLevels !== undefined && node.educationLevels.length > 0 && !node.educationLevels.some((level) => levels.has(level))) continue;
      goals.push({ frameworkKey: state.frameworkKey, competencyUri: node.uri, code: overlay?.localLabel ?? node.humanCodingScheme!, statement: node.fullStatement });
    }
  }
  return { goals, approvedReleases };
}
