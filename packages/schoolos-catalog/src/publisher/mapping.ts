// Maps the publisher-text rows (SCHO-63) onto registry record rows: the CCSS high-school and 6-12
// literacy standards read from thecorestandards.org (`scripts/generate-ccss-publisher-rows.ts`),
// and the C3 indicators transcribed from the NCSS publication (`scripts/generate-c3-rows.ts`).
//
// Every record is `derived`: SchoolOS read the text from the publisher's page or PDF, which is not
// the same as importing the publisher's own record. A statement that failed its check is an empty
// `fullStatement`, and each node's `extensions` say which check it passed or failed.
import type { Provenance } from "@schoolos/registry";
import { z } from "zod";
import type { RecordLevel, RecordRow } from "../records.ts";
import c3File from "./c3-rows.json" with { type: "json" };
import ccssFile from "./ccss-rows.json" with { type: "json" };

/** The `extensions` key on every publisher-text node: `{ source, textCheck }`, plus `modeling` for CCSS. */
export const PUBLISHER_TEXT_EXTENSION = "schoolos:catalog-publisher-text";

const EducationLevels = z.array(z.enum(["KG", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"])).min(1);

/** One CCSS statement read from the publisher's page, as `ccss-rows.json` stores it. */
export const CcssPublisherRow = z.strictObject({
  framework: z.enum(["ccss-math", "ccss-ela"]),
  code: z.string().regex(/^CCSS\.(?:MATH\.CONTENT|ELA-LITERACY)\.[A-Z0-9.-]+$/),
  shortCode: z.string().regex(/^[A-Za-z0-9.-]+$/),
  kind: z.enum(["standard", "component"]),
  educationLevels: EducationLevels,
  /** Math: the conceptual category. ELA: the strand. */
  group: z.string().min(1),
  /** Math: the domain. ELA: null. */
  domain: z.string().min(1).nullable(),
  /** Math: the cluster heading. ELA: the heading. */
  heading: z.string().min(1),
  statement: z.string().min(1).nullable(),
  /** Whether the page's statement also appears, word for word, in the publisher's PDF edition. */
  textCheck: z.enum(["verified-against-pdf", "not-in-pdf"]),
  /** Marked with the modeling star (★). */
  modeling: z.boolean(),
  page: z.url(),
}).refine((row) => (row.statement !== null) === (row.textCheck === "verified-against-pdf"), "a statement ships exactly when it was verified");
/** A CCSS publisher row. */
export type CcssPublisherRow = z.infer<typeof CcssPublisherRow>;

/** One C3 indicator transcribed from the NCSS publication, as `c3-rows.json` stores it. */
export const C3Row = z.strictObject({
  code: z.string().regex(/^D[1-4]\.(?:(?:Civ|Eco|Geo|His)\.)?\d{1,2}\.(?:K-2|3-5|6-8|9-12)$/),
  dimension: z.string().regex(/^Dimension [1-4]: .+$/),
  discipline: z.enum(["Civics", "Economics", "Geography", "History"]).nullable(),
  /** The table's subject, such as `Civic and Political Institutions`. */
  category: z.string().min(1),
  /** The indicator without its band, such as `D2.Civ.1`. */
  indicator: z.string().min(1),
  band: z.enum(["K-2", "3-5", "6-8", "9-12"]),
  educationLevels: EducationLevels,
  statement: z.string().min(1).nullable(),
  /** Whether a second reading of the PDF has the same words, whole. */
  textCheck: z.enum(["verified-against-reading-order", "not-in-reading-order"]),
  /** The PDF page the indicator was read from. */
  page: z.number().int().positive(),
}).refine((row) => (row.statement !== null) === (row.textCheck === "verified-against-reading-order"), "a statement ships exactly when it was verified");
/** A C3 row. */
export type C3Row = z.infer<typeof C3Row>;

const CcssFile = z.strictObject({
  /** The notice the CCSS Public License requires on any copy of the standards. */
  notice: z.string().min(1),
  reference: z.strictObject({ site: z.url(), pdfs: z.array(z.url()).min(1), retrievedOn: z.iso.date() }),
  rows: z.array(CcssPublisherRow),
});
const C3File = z.strictObject({
  /** The citation NCSS asks reproductions to carry. */
  citation: z.string().min(1),
  source: z.strictObject({ pdf: z.url(), retrievedOn: z.iso.date() }),
  rows: z.array(C3Row),
});

const ccss = CcssFile.parse(ccssFile);
const c3 = C3File.parse(c3File);

/** Where the CCSS publisher rows were read from, and when. */
export const CCSS_PUBLISHER_REFERENCE = ccss.reference;
/** Where the C3 rows were transcribed from, and when. */
export const C3_SOURCE = c3.source;

/** The CCSS publisher rows for one framework, in page order. */
export function ccssPublisherRows(framework: CcssPublisherRow["framework"]): readonly CcssPublisherRow[] {
  return ccss.rows.filter((row) => row.framework === framework);
}

/** Every C3 row, in the order the publication sets them. */
export function c3Rows(): readonly C3Row[] {
  return c3.rows;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const at = (date: string) => `${date}T00:00:00Z`;

function ccssProvenance(row: CcssPublisherRow): Provenance {
  return { source: "derived", sourceUri: row.page, retrievedAt: at(ccss.reference.retrievedOn), sourceRevision: "ccss@2010" };
}

/**
 * The record rows for one framework's CCSS publisher rows. Mathematics is conceptual category,
 * domain, cluster, standard, then lettered component; ELA/Literacy is strand and grade band,
 * heading, standard, then component, as the K-8 seeds are.
 */
export function ccssPublisherRecordRows(framework: CcssPublisherRow["framework"]): RecordRow[] {
  const rows = ccssPublisherRows(framework);
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const prefix = framework === "ccss-math" ? "CCSS.MATH.CONTENT." : "CCSS.ELA-LITERACY.";
  const standardLevel = (row: CcssPublisherRow, itemType: string): RecordLevel => ({
    code: row.code,
    humanCodingScheme: row.shortCode,
    itemType,
    statement: row.statement ?? "",
  });
  return rows.map((row) => {
    const parts = row.shortCode.split(".");
    const groups: RecordLevel[] = framework === "ccss-math"
      ? [
        { code: `${prefix}${parts[0]}`, humanCodingScheme: parts[0]!, itemType: "Conceptual Category", statement: row.group },
        { code: `${prefix}${parts.slice(0, 2).join(".")}`, humanCodingScheme: parts.slice(0, 2).join("."), itemType: "Domain", statement: row.domain ?? "" },
        { code: `${prefix}${parts.slice(0, 3).join(".")}`, humanCodingScheme: parts.slice(0, 3).join("."), itemType: "Cluster", statement: row.heading },
      ]
      : [
        { code: `${prefix}${parts.slice(0, 2).join(".").toUpperCase()}`, humanCodingScheme: parts.slice(0, 2).join("."), itemType: "Strand", statement: row.group },
        // An uncoded heading, coded as the K-8 seeds code theirs.
        { code: `${prefix}${parts.slice(0, 2).join(".").toUpperCase()}.${slug(row.heading)}`, itemType: "Heading", statement: row.heading },
      ];
    const standard = row.kind === "component" ? byCode.get(row.code.slice(0, row.code.lastIndexOf("."))) : undefined;
    if (row.kind === "component" && standard === undefined) throw new Error(`${row.code} has no standard above it`);
    const levels = [...groups, ...(standard === undefined ? [] : [standardLevel(standard, "Standard")]), standardLevel(row, row.kind === "component" ? "Component" : "Standard")];
    const checked = row.statement === null
      ? "Statement withheld: the publisher's page and its PDF edition differ. Import the official text through CASE."
      : `Statement from the publisher's page, matched word for word against its PDF edition on ${ccss.reference.retrievedOn}.`;
    return {
      levels,
      educationLevels: row.educationLevels,
      item: {
        notes: `${checked}${row.modeling ? " A modeling standard (★)." : ""}`,
        extensions: { [PUBLISHER_TEXT_EXTENSION]: { source: row.page, textCheck: row.textCheck, ...(row.modeling ? { modeling: true } : {}) } },
        provenance: ccssProvenance(row),
      },
      grouping: {
        notes: `A heading from the publisher's page, as published.`,
        extensions: { [PUBLISHER_TEXT_EXTENSION]: { source: row.page, textCheck: "grouping" } },
        provenance: ccssProvenance(row),
      },
      hierarchySource: row.page,
    };
  });
}

/**
 * The record rows for the C3 indicators: dimension, then discipline (Dimension 2 only), then the
 * table's category, then each grade-band indicator. The publication gives an indicator's number no
 * statement of its own, so the bands sit directly under their category.
 */
export function c3RecordRows(): RecordRow[] {
  const provenance: Provenance = { source: "derived", sourceUri: c3.source.pdf, retrievedAt: at(c3.source.retrievedOn), sourceRevision: "c3@2013" };
  return c3.rows.map((row) => {
    const dimension = row.code.slice(0, 2);
    const discipline = row.discipline === null ? undefined : row.code.split(".")[1]!;
    const top = `C3.${dimension}${discipline === undefined ? "" : `.${discipline}`}`;
    const levels: RecordLevel[] = [
      { code: `C3.${dimension}`, humanCodingScheme: dimension, itemType: "Dimension", statement: row.dimension.replace(/^Dimension [1-4]: /, "") },
      ...(discipline === undefined ? [] : [{ code: top, humanCodingScheme: `${dimension}.${discipline}`, itemType: "Discipline", statement: row.discipline! }]),
      { code: `${top}.${slug(row.category)}`, itemType: "Category", statement: row.category },
      { code: `C3.${row.code}`, humanCodingScheme: row.code, itemType: "Indicator", statement: row.statement ?? "" },
    ];
    return {
      levels,
      educationLevels: row.educationLevels,
      item: {
        notes: row.statement === null
          ? "Statement withheld: two readings of the NCSS publication disagree."
          : `Transcribed by SchoolOS from the NCSS publication (PDF page ${row.page}), matched word for word against a second reading of it on ${c3.source.retrievedOn}.`,
        extensions: { [PUBLISHER_TEXT_EXTENSION]: { source: `${c3.source.pdf}#page=${row.page}`, textCheck: row.textCheck } },
        provenance,
      },
      grouping: {
        notes: "A heading from the NCSS publication, as published.",
        extensions: { [PUBLISHER_TEXT_EXTENSION]: { source: c3.source.pdf, textCheck: "grouping" } },
        provenance,
      },
      hierarchySource: c3.source.pdf,
    };
  });
}
