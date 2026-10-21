import { CATALOG } from "./catalog.ts";
import type { CatalogEntry, CoverageState } from "./entry.ts";
import type { FrameworkMirrorState } from "./mirror.ts";
import { CatalogSubject, GRADE_BANDS, type GradeBand, gradeBandsOf } from "./vocabulary.ts";

/**
 * Where a selected framework stands for one subject and band, best first.
 *
 * - `covered`: the approved release has items with text in the band.
 * - `text-withheld`: the approved release has items in the band, but without their text.
 * - `install-required`: the catalog ships items for the band, but no release is approved.
 * - `import-required`: a declared source covers the band; the district has not imported it.
 * - `gap`: the framework offers nothing for the band.
 */
export type FrameworkCoverage = "covered" | "text-withheld" | "install-required" | "import-required" | "gap";

const RANK: readonly FrameworkCoverage[] = ["covered", "text-withheld", "install-required", "import-required", "gap"];

/** One subject and grade band of a district's coverage. */
export interface CoverageCell {
  subject: CatalogSubject;
  band: GradeBand;
  /** The best coverage any selected framework gives, or `gap` when none gives any. */
  status: FrameworkCoverage;
  /** Each selected framework that declares the subject, and what it gives this band. */
  frameworks: Array<{ key: string; coverage: FrameworkCoverage; note: string | undefined }>;
}

/** A district's coverage across every catalog subject and grade band. */
export interface CoverageReport {
  cells: CoverageCell[];
  /** The cells with no coverage at all, for the admin UI to flag. */
  gaps: CoverageCell[];
}

const FROM_CATALOG: Readonly<Record<CoverageState, FrameworkCoverage>> = {
  "items": "install-required",
  "items-without-text": "install-required",
  "pointer": "import-required",
  "gap": "gap",
};

/**
 * The bands the approved release has items in, with and without text. Only leaf items count: a
 * domain or cluster heading has text of its own but is not something a learner is assessed on.
 */
function approvedBands(state: FrameworkMirrorState): { withText: Set<GradeBand>; withoutText: Set<GradeBand> } | undefined {
  const approved = state.releases.find((r) => r.status === "approved");
  if (approved === undefined) return undefined;
  const { nodes = [], associations = [] } = approved.release.content;
  const parents = new Set(associations.filter((a) => a.relation === "child-of").map((a) => a.destination.uri));
  const withText = new Set<GradeBand>();
  const withoutText = new Set<GradeBand>();
  for (const node of nodes.filter((n) => !parents.has(n.uri))) {
    for (const band of gradeBandsOf(node.educationLevels)) (node.fullStatement === "" ? withoutText : withText).add(band);
  }
  return { withText, withoutText };
}

function frameworkCoverage(entry: CatalogEntry, state: FrameworkMirrorState, subject: CatalogSubject, band: GradeBand) {
  const row = entry.coverage.find((r) => r.subject === subject && r.band === band);
  const declared = row === undefined ? "gap" : FROM_CATALOG[row.state];
  const bands = approvedBands(state);
  // An approved release is credited to every subject its catalog entry declares. A release whose
  // items carry no education levels (TEKS today) credits no band, so the catalog's view stands.
  const installed: FrameworkCoverage | undefined = bands?.withText.has(band)
    ? "covered"
    : bands?.withoutText.has(band) ? "text-withheld" : undefined;
  const coverage = installed !== undefined && RANK.indexOf(installed) < RANK.indexOf(declared) ? installed : declared;
  return { key: entry.key, coverage, note: row?.note };
}

/**
 * Reports which subjects and grade bands a district's selected frameworks cover, from what it has
 * approved and what the catalog declares, and flags the gaps. Subjects no selected framework
 * declares appear as gaps too, so the admin UI can show what is missing as well as what is thin.
 */
export function coverageReport(selections: readonly FrameworkMirrorState[], catalog: readonly CatalogEntry[] = CATALOG): CoverageReport {
  const selected = selections.flatMap((state) => {
    const entry = catalog.find((e) => e.key === state.frameworkKey);
    return entry === undefined ? [] : [{ entry, state }];
  });
  const cells = CatalogSubject.options.flatMap((subject) =>
    GRADE_BANDS.map((band): CoverageCell => {
      const frameworks = selected
        .filter(({ entry }) => entry.subjects.includes(subject))
        .map(({ entry, state }) => frameworkCoverage(entry, state, subject, band));
      const status = frameworks.map((f) => f.coverage).toSorted((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0] ?? "gap";
      return { subject, band, status, frameworks };
    }));
  return { cells, gaps: cells.filter((cell) => cell.status === "gap") };
}
