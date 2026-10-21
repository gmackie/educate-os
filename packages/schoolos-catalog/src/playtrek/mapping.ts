// Maps PlayTrek's standards seed rows (`packages/db/src/seed/standards/` at commit 7258e4347, via
// the generated `seed-rows.json`) onto registry records: one `CompetencyNode` per standard and per
// grouping above it, and `child-of` associations for the hierarchy (SCHO-44).
//
// PlayTrek flattened each row's grade to one number (`gradeLevel`, with pre-K as -1 and every
// CASEL band stored as its lowest grade). The mapping restores the published education levels
// from the code instead: CCSS `K.CC.A.1` is `["KG"]`, as CASE Network publishes it, and a CASEL
// `K2` indicator is `["KG", "01", "02"]`. It then checks the restored levels agree with
// `gradeLevel`, so a code and grade that disagree fail rather than guess.
//
// Every record is `derived` with PlayTrek as the transcriber, never `official`. Text the licensing
// decisions withhold is an empty `fullStatement`, and each node's `extensions` say why.
import { SchoolOsError } from "@schoolos/contracts";
import {
  type CompetencyAssociation,
  type CompetencyNode,
  type FrameworkDefinition,
  FrameworkRelease,
  type NodeLink,
  type Provenance,
} from "@schoolos/registry";
import { z } from "zod";
import { catalogUuid } from "../digest.ts";
import seedFile from "./seed-rows.json" with { type: "json" };

/** How a seed row's text was checked before it shipped (see `scripts/generate-playtrek-seeds.ts`). */
export const SeedTextCheck = z.enum([
  // Matches the publisher's own text exactly.
  "verbatim",
  // Matches it except for list-label style, dash and quote glyphs, whitespace and full stops.
  "formatting-only",
  // Differs from the publisher's text in wording; withheld.
  "differs",
  // The publisher's page has no such code; withheld.
  "missing-from-reference",
  // PlayTrek's own paraphrase of a public-domain framework; ships as written.
  "paraphrase",
  // The framework's terms do not permit redistribution; withheld.
  "withheld-by-license",
]);
/** A seed text check. */
export type SeedTextCheck = z.infer<typeof SeedTextCheck>;

/** The frameworks PlayTrek seeds exist for. */
export const PLAYTREK_SEEDED_FRAMEWORKS = ["ccss-math", "ccss-ela", "casel-5", "head-start-elof"] as const;
/** A framework PlayTrek seeds exist for. */
export type PlayTrekSeededFramework = (typeof PLAYTREK_SEEDED_FRAMEWORKS)[number];

/** One PlayTrek seed row, as `seed-rows.json` stores it. */
export const PlayTrekSeedRow = z.strictObject({
  framework: z.enum(PLAYTREK_SEEDED_FRAMEWORKS),
  code: z.string().regex(/^[A-Za-z0-9.-]+$/),
  shortCode: z.string().min(1),
  domain: z.string().min(1),
  /** The grouping heading between domain and standard; null where the licensing decision withholds it. */
  cluster: z.string().min(1).nullable(),
  /** The statement; null where it is withheld. */
  statement: z.string().min(1).nullable(),
  textCheck: SeedTextCheck,
  gradeLevel: z.number().int().min(-1).max(12),
  subject: z.string().min(1),
  parentCode: z.string().regex(/^[A-Za-z0-9.-]+$/),
}).refine(
  (row) => (row.statement !== null) === ["verbatim", "formatting-only", "paraphrase"].includes(row.textCheck),
  "a statement ships exactly when its text check allows it",
);
/** A PlayTrek seed row. */
export type PlayTrekSeedRow = z.infer<typeof PlayTrekSeedRow>;

const SeedFile = z.strictObject({
  /** The notices the frameworks' terms require on any copy of their text, keyed by framework. */
  notices: z.record(z.string(), z.string().min(1)),
  source: z.strictObject({ path: z.string(), commit: z.string().regex(/^[0-9a-f]{7,40}$/) }),
  ccssReference: z.strictObject({ site: z.url(), retrievedOn: z.iso.date() }),
  rows: z.array(PlayTrekSeedRow),
});

const seeds = SeedFile.parse(seedFile);

/** The PlayTrek commit the seed rows were extracted from. */
export const PLAYTREK_SEED_COMMIT = seeds.source.commit;
/** The PlayTrek path the seed rows were extracted from. */
export const PLAYTREK_SEED_PATH = seeds.source.path;

/** The seed rows for one framework, in PlayTrek's order. */
export function playTrekSeedRows(framework: PlayTrekSeededFramework): readonly PlayTrekSeedRow[] {
  return seeds.rows.filter((row) => row.framework === framework);
}

/** Where every seed-derived record says it came from: PlayTrek's seed files at the pinned commit. */
const SEED_SOURCE_URI = `urn:schoolos:playtrek:${seeds.source.commit}:${seeds.source.path}`;
const RECORDED_AT = `${seeds.ccssReference.retrievedOn}T00:00:00Z`;
const PROVENANCE: Provenance = {
  source: "derived",
  sourceUri: SEED_SOURCE_URI,
  retrievedAt: RECORDED_AT,
  sourceRevision: `playtrek@${seeds.source.commit}`,
};

/**
 * The `extensions` key on every seed-derived node: `{ transcriber, textCheck }`, where `textCheck`
 * is a {@link SeedTextCheck} for a standard and `grouping` for a node above the standards.
 */
export const SEED_EXTENSION = "schoolos:catalog-seed";

/** CEDS grade codes, kindergarten through grade 12. */
const GRADES = ["KG", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] as const;
const gradeCode = (grade: string) => (grade === "K" ? "KG" : grade.padStart(2, "0"));
const PLAYTREK_GRADE: Readonly<Record<string, number>> = { PK: -1, ...Object.fromEntries(GRADES.map((g, i) => [g, i])) };
const CASEL_BANDS: Readonly<Record<string, readonly string[]>> = {
  K2: ["KG", "01", "02"],
  "35": ["03", "04", "05"],
  "68": ["06", "07", "08"],
};
const CASEL_BAND_LABELS: Readonly<Record<string, string>> = { K2: "grades K-2", "35": "grades 3-5", "68": "grades 6-8" };

/** One level of a row's hierarchy, from the framework's top grouping down to the row itself. */
interface Level {
  code: string;
  humanCodingScheme?: string;
  itemType: string;
  statement: string;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The published education levels a row's code encodes. */
function educationLevelsOf(row: PlayTrekSeedRow): string[] {
  const parts = row.code.split(".");
  switch (row.framework) {
    case "ccss-math":
    case "ccss-ela":
      return [gradeCode(parts[3]!)];
    case "casel-5": {
      const band = CASEL_BANDS[parts[3]!];
      if (band === undefined) throw invalid(row, "has no CASEL grade band");
      return [...band];
    }
    case "head-start-elof":
      return ["PK"];
  }
}

/** The groupings above a row, top first, then the row. */
function levelsOf(row: PlayTrekSeedRow): Level[] {
  const standard: Level = {
    code: row.code,
    humanCodingScheme: row.shortCode,
    itemType: row.framework === "head-start-elof" ? "Goal" : row.framework === "casel-5" ? "Indicator" : "Standard",
    statement: row.statement ?? "",
  };
  const parent = row.parentCode;
  const parentShort = (prefix: string) => parent.slice(prefix.length);
  switch (row.framework) {
    case "ccss-math": {
      // CCSS.MATH.CONTENT.K.CC.A.1: domain K.CC, cluster K.CC.A.
      const domainCode = parent.split(".").slice(0, -1).join(".");
      return [
        { code: domainCode, humanCodingScheme: domainCode.slice("CCSS.MATH.CONTENT.".length), itemType: "Domain", statement: row.domain },
        { code: parent, humanCodingScheme: parentShort("CCSS.MATH.CONTENT."), itemType: "Cluster", statement: row.cluster ?? "" },
        standard,
      ];
    }
    case "ccss-ela":
      // CCSS.ELA-LITERACY.RL.K.1: strand and grade RL.K, then an uncoded heading such as
      // "Key Ideas and Details".
      return [
        { code: parent, humanCodingScheme: parentShort("CCSS.ELA-LITERACY."), itemType: "Strand", statement: row.domain },
        { code: `${parent}.${slug(row.cluster ?? "")}`, itemType: "Heading", statement: row.cluster ?? "" },
        standard,
      ];
    case "casel-5": {
      // CASEL.SEL.SA.K2.1: competency SA, then PlayTrek's K-2 band. The competency's name is
      // CASEL's; the band label is SchoolOS's own wording.
      const competency = parent.split(".").slice(0, -1).join(".");
      const band = parent.split(".").at(-1)!;
      return [
        { code: competency, humanCodingScheme: competency.slice("CASEL.".length), itemType: "Competency", statement: row.domain },
        {
          code: parent,
          humanCodingScheme: parentShort("CASEL."),
          itemType: "Grade band",
          statement: `${row.domain}, ${CASEL_BAND_LABELS[band] ?? band}`,
        },
        standard,
      ];
    }
    case "head-start-elof":
      // ELOF.P-LIT.1: domain P-LIT, then the sub-domain heading.
      return [
        { code: parent, humanCodingScheme: parentShort("ELOF."), itemType: "Domain", statement: row.domain },
        { code: `${parent}.${slug(row.cluster ?? "")}`, itemType: "Sub-domain", statement: row.cluster ?? "" },
        standard,
      ];
  }
}

function invalid(row: PlayTrekSeedRow, message: string): SchoolOsError {
  return new SchoolOsError("validation-failed", `PlayTrek seed ${row.code} ${message}`);
}

const SUBJECT_LABELS: Readonly<Record<PlayTrekSeededFramework, string>> = {
  "ccss-math": "Mathematics",
  "ccss-ela": "English Language Arts & Literacy",
  "casel-5": "Social and Emotional Learning",
  "head-start-elof": "Early Learning",
};

function notesFor(textCheck: SeedTextCheck): string {
  const transcribed = `Transcribed by PlayTrek (seed commit ${seeds.source.commit}); not the publisher's own record.`;
  switch (textCheck) {
    case "verbatim":
    case "formatting-only":
      return `${transcribed} Statement checked word for word against ${seeds.ccssReference.site} on ${seeds.ccssReference.retrievedOn}.`;
    case "paraphrase":
      return `${transcribed} PlayTrek's paraphrase of the publisher's goal, not a quotation.`;
    case "differs":
    case "missing-from-reference":
      return `${transcribed} Statement withheld: it does not match the publisher's text. Import the official text through CASE.`;
    case "withheld-by-license":
      return `${transcribed} A PlayTrek-authored indicator aligned to the framework, not the publisher's text; withheld under the framework's terms.`;
  }
}

const GROUPING_NOTE = `A grouping from PlayTrek's seed hierarchy (seed commit ${seeds.source.commit}), labelled as PlayTrek recorded it.`;

/** The order education levels are listed in: pre-K, then kindergarten through grade 12. */
const LEVEL_ORDER = ["PK", ...GRADES];

/**
 * Builds the release of registry records for one PlayTrek-seeded framework, from the shipped seed
 * rows unless `rows` replaces them.
 *
 * @throws SchoolOsError `validation-failed` if a row's code and grade disagree, a grouping is given
 *   two different statements, or the records do not form a valid release.
 */
export async function playTrekSeedRelease(
  key: PlayTrekSeededFramework,
  framework: FrameworkDefinition,
  rows: readonly PlayTrekSeedRow[] = playTrekSeedRows(key),
): Promise<FrameworkRelease> {
  const frameworkLink: NodeLink = { title: framework.title, identifier: framework.identifier, uri: framework.uri };
  const uriOf = (code: string) => `urn:schoolos:catalog:${key}:${code}`;

  /** A node being assembled: its level, the education levels of the rows under it, and its parent. */
  interface Draft { level: Level; levels: Set<string>; textCheck: SeedTextCheck | undefined; parent: string | undefined }
  const drafts = new Map<string, Draft>();
  for (const row of rows) {
    const levels = educationLevelsOf(row);
    if (PLAYTREK_GRADE[levels[0]!] !== row.gradeLevel) {
      throw invalid(row, `has gradeLevel ${row.gradeLevel}, but its code says ${levels.join(", ")}`);
    }
    const path = levelsOf(row);
    for (const [depth, level] of path.entries()) {
      const isRow = depth === path.length - 1;
      const existing = drafts.get(level.code);
      if (existing === undefined) {
        drafts.set(level.code, {
          level,
          levels: new Set(levels),
          textCheck: isRow ? row.textCheck : undefined,
          parent: path[depth - 1]?.code,
        });
      } else if (isRow || existing.level.statement !== level.statement) {
        throw invalid(row, isRow ? "appears twice" : `gives ${level.code} a second statement`);
      } else {
        for (const l of levels) existing.levels.add(l);
      }
    }
  }

  const nodes: CompetencyNode[] = [];
  const associations: CompetencyAssociation[] = [];
  for (const [code, draft] of drafts) {
    const uri = uriOf(code);
    const identifier = await catalogUuid(uri);
    nodes.push({
      uri,
      identifier,
      frameworkLink,
      fullStatement: draft.level.statement,
      ...(draft.level.humanCodingScheme === undefined ? {} : { humanCodingScheme: draft.level.humanCodingScheme }),
      itemType: draft.level.itemType,
      educationLevels: LEVEL_ORDER.filter((l) => draft.levels.has(l)),
      subjects: [SUBJECT_LABELS[key]],
      language: "en",
      lastChangeDateTime: RECORDED_AT,
      notes: draft.textCheck === undefined ? GROUPING_NOTE : notesFor(draft.textCheck),
      extensions: { [SEED_EXTENSION]: { transcriber: "PlayTrek", textCheck: draft.textCheck ?? "grouping" } },
      provenance: PROVENANCE,
    });
    const parentUri = draft.parent === undefined ? undefined : uriOf(draft.parent);
    const destination = parentUri === undefined
      ? { ...frameworkLink, targetType: "CFDocument" }
      : { title: drafts.get(draft.parent!)!.level.statement, identifier: await catalogUuid(parentUri), uri: parentUri };
    const associationId = await catalogUuid(`${uri} isChildOf ${destination.uri}`);
    associations.push({
      uri: `urn:schoolos:catalog:${key}:association:${associationId}`,
      identifier: associationId,
      relation: "child-of",
      origin: { title: draft.level.statement, identifier, uri },
      destination,
      frameworkLink,
      lastChangeDateTime: RECORDED_AT,
      // The hierarchy is PlayTrek's `parentCode`, so PlayTrek's seed is what asserts it.
      evidence: [{ basis: "publisher-assertion", sourceUri: SEED_SOURCE_URI }],
      provenance: PROVENANCE,
    });
  }

  const release = FrameworkRelease.safeParse({ framework, nodes, associations });
  if (!release.success) {
    throw new SchoolOsError("validation-failed", `PlayTrek seeds for ${key} do not form a valid release`);
  }
  return release.data;
}
