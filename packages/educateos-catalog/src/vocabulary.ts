import { z } from "zod";

/**
 * Identifies a framework in the catalog, such as `ccss-math`. Stable across catalog releases, so a
 * district's selection survives an upgrade.
 */
export const CatalogKey = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, "expected a catalog key such as ccss-math").brand<"CatalogKey">();
/** A catalog key. */
export type CatalogKey = z.infer<typeof CatalogKey>;

/**
 * The subjects the coverage report is organized by. Frameworks covering other subjects (TEKS has
 * many) are reported only for these; the admin UI's question is whether the core subjects are
 * covered.
 */
export const CatalogSubject = z.enum([
  "mathematics",
  "english-language-arts",
  "science",
  "social-studies",
  "social-emotional-learning",
]);
/** A catalog subject. */
export type CatalogSubject = z.infer<typeof CatalogSubject>;

/**
 * The grade bands the coverage report is organized by. A band summarizes coverage for the admin
 * UI; it never replaces the education levels a publisher gave an item, which are kept verbatim on
 * each node.
 */
export const GradeBand = z.enum(["PK", "K-2", "3-5", "6-8", "9-12"]);
/** A grade band. */
export type GradeBand = z.infer<typeof GradeBand>;

/** Every grade band, youngest first. */
export const GRADE_BANDS: readonly GradeBand[] = GradeBand.options;

/**
 * The CEDS education level codes CASE publishers use (`KG`, `01` … `12`, `PK`), and the band each
 * falls in. CASE Network's own CCSS and NGSS packages use these codes, including lists such as
 * `["09", "10", "11", "12"]` for a high-school item.
 */
const BAND_BY_EDUCATION_LEVEL: ReadonlyMap<string, GradeBand> = new Map([
  ["PK", "PK"],
  ["TK", "PK"],
  ["KG", "K-2"],
  ["01", "K-2"],
  ["02", "K-2"],
  ["03", "3-5"],
  ["04", "3-5"],
  ["05", "3-5"],
  ["06", "6-8"],
  ["07", "6-8"],
  ["08", "6-8"],
  ["09", "9-12"],
  ["10", "9-12"],
  ["11", "9-12"],
  ["12", "9-12"],
]);

/**
 * The grade bands a node's published education levels touch, youngest first. Codes outside K-12
 * and pre-K (such as `PS` for postsecondary) belong to no band.
 */
export function gradeBandsOf(educationLevels: readonly string[] | undefined): GradeBand[] {
  const bands = new Set<GradeBand>();
  for (const level of educationLevels ?? []) {
    const band = BAND_BY_EDUCATION_LEVEL.get(level);
    if (band !== undefined) bands.add(band);
  }
  return GRADE_BANDS.filter((band) => bands.has(band));
}
