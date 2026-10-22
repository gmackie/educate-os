// Generates `src/publisher/ccss-rows.json`: the CCSS high-school Mathematics and ELA/Literacy
// standards and the grade 6-12 literacy standards (RH, RST, WHST), read from the publisher's own
// pages on thecorestandards.org (SCHO-63). Every statement is checked against the publisher's PDF
// edition (`ccss-publisher-text.ts` explains the rules); one that does not match ships with its
// text withheld, as C02 withheld a transcription that differed. SchoolOS writes none of this text.
//
// Usage (authoring time only, never in a Worker; needs poppler's `pdftotext`):
//   node scripts/generate-ccss-publisher-rows.ts --pages <cache dir>
// The pages and PDFs are downloaded into the cache directory unless already there.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CCSS_NOTICE, CCSS_PDFS, CCSS_SITE, inPdf, pdfReference, publisherPage, type PublisherPage } from "./ccss-publisher-text.ts";

const { values } = parseArgs({ options: { pages: { type: "string" } } });
if (values.pages === undefined) throw new Error("usage: generate-ccss-publisher-rows.ts --pages <dir>");
const pageDir = resolve(values.pages);

const MATH_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  HSN: ["RN", "Q", "CN", "VM"],
  HSA: ["SSE", "APR", "CED", "REI"],
  HSF: ["IF", "BF", "LE", "TF"],
  HSG: ["CO", "SRT", "C", "GPE", "GMD", "MG"],
  HSS: ["ID", "IC", "CP", "MD"],
};
const ELA_STRANDS = ["RL", "RI", "W", "SL", "L"] as const;
const LITERACY_STRANDS = ["RH", "RST", "WHST"] as const;
/**
 * The literacy strands' names as the publisher's ELA PDF titles them. Their web pages title RH and
 * RST by subject alone and WHST as plain "Writing", which would be ambiguous beside the W strand.
 */
const LITERACY_NAMES: Readonly<Record<(typeof LITERACY_STRANDS)[number], string>> = {
  RH: "Reading Standards for Literacy in History/Social Studies",
  RST: "Reading Standards for Literacy in Science and Technical Subjects",
  WHST: "Writing Standards for Literacy in History/Social Studies, Science, and Technical Subjects",
};
const LEVELS: Readonly<Record<string, readonly string[]>> = {
  "6-8": ["06", "07", "08"],
  "9-10": ["09", "10"],
  "11-12": ["11", "12"],
  "HS": ["09", "10", "11", "12"],
};

type TextCheck = "verified-against-pdf" | "not-in-pdf";

interface Row {
  framework: "ccss-math" | "ccss-ela";
  /** The publisher's identifier, upper-cased as the PlayTrek-derived K-8 codes are. */
  code: string;
  /** The identifier without its `CCSS.Math.Content.` or `CCSS.ELA-Literacy.` prefix, as published. */
  shortCode: string;
  kind: "standard" | "component";
  educationLevels: readonly string[];
  /** Math: the conceptual category. ELA: the strand. */
  group: string;
  /** Math: the domain. ELA: absent. */
  domain: string | null;
  /** Math: the cluster heading. ELA: the heading, such as "Key Ideas and Details". */
  heading: string;
  statement: string | null;
  textCheck: TextCheck;
  modeling: boolean;
  page: string;
}

const [mathPdf, elaPdf] = [
  await pdfReference(CCSS_PDFS.math, pageDir, "Math_Standards1.pdf"),
  await pdfReference(CCSS_PDFS.ela, pageDir, "ELA_Standards1.pdf"),
];

function rowsOf(page: PublisherPage, framework: Row["framework"], levels: readonly string[], names: { group: string; domain: string | null }): Row[] {
  const prefix = framework === "ccss-math" ? "CCSS.Math.Content." : "CCSS.ELA-Literacy.";
  if (page.statements.length === 0) throw new Error(`${page.url}: no statements`);
  // RL.9-10.8 and RL.11-12.8 are placeholders ("not applicable to literature"), not standards.
  return page.statements.filter((s) => !/^\([A-Z.0-9-]+ not applicable to literature\)$/.test(s.text)).map((s) => {
    if (!s.anchor.startsWith(prefix)) throw new Error(`${page.url}: unexpected identifier ${s.anchor}`);
    const verified = inPdf(s.text, framework === "ccss-math" ? mathPdf : elaPdf);
    return {
      framework,
      code: s.anchor.toUpperCase(),
      shortCode: s.anchor.slice(prefix.length),
      kind: s.kind,
      educationLevels: levels,
      ...names,
      heading: s.heading,
      statement: verified ? s.text : null,
      textCheck: verified ? "verified-against-pdf" : "not-in-pdf",
      modeling: s.modeling,
      page: page.url,
    };
  });
}

const rows: Row[] = [];
for (const [category, domains] of Object.entries(MATH_DOMAINS)) {
  for (const domain of domains) {
    const page = await publisherPage(`Math/Content/${category}/${domain}/`, pageDir);
    const [group, domainName] = page.title;
    if (group === undefined || domainName === undefined || !group.startsWith("High School: ")) throw new Error(`${page.url}: unexpected title`);
    rows.push(...rowsOf(page, "ccss-math", LEVELS["HS"]!, { group: group.slice("High School: ".length), domain: domainName }));
  }
}
for (const strand of ELA_STRANDS) {
  for (const band of ["9-10", "11-12"]) {
    const page = await publisherPage(`ELA-Literacy/${strand}/${band}/`, pageDir);
    rows.push(...rowsOf(page, "ccss-ela", LEVELS[band]!, { group: page.title[1]!, domain: null }));
  }
}
for (const strand of LITERACY_STRANDS) {
  for (const band of ["6-8", "9-10", "11-12"]) {
    const page = await publisherPage(`ELA-Literacy/${strand}/${band}/`, pageDir);
    rows.push(...rowsOf(page, "ccss-ela", LEVELS[band]!, { group: LITERACY_NAMES[strand], domain: null }));
  }
}

const header = {
  // The CCSS license requires this notice on any publication of the standards, this file included.
  notice: CCSS_NOTICE,
  reference: { site: CCSS_SITE, pdfs: Object.values(CCSS_PDFS), retrievedOn: new Date().toLocaleDateString("en-CA") },
};
// One row per line, so a regenerated file diffs row by row.
const json = `${JSON.stringify(header).slice(0, -1)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
writeFileSync(new URL("../src/publisher/ccss-rows.json", import.meta.url), json);
const counts = Object.groupBy(rows, (r) => `${r.framework}:${r.textCheck}`);
console.log(Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v?.length])));
for (const row of rows.filter((r) => r.textCheck === "not-in-pdf")) console.log("not in PDF:", row.shortCode);
