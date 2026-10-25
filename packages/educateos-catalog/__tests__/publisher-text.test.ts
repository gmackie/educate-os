// Publisher text (SCHO-63): the CCSS high-school and 6-12 literacy standards read from the
// publisher's pages, and the C3 indicators transcribed from the NCSS publication. Every statement
// ships only after a second publisher source matched it, and every record says it is derived.
import { PrincipalId } from "@educateos/contracts";
import { describe, expect, it } from "vitest";
import {
  c3Rows,
  CatalogMirror,
  catalogEntry,
  catalogSeedRelease,
  ccssPublisherRows,
  coverageReport,
  InMemoryCatalogMirrorStorage,
  PUBLISHER_TEXT_EXTENSION,
} from "../src/index.ts";

type Release = Awaited<ReturnType<typeof catalogSeedRelease>>;

const node = (release: Release, code: string) => {
  const found = release.content.nodes!.find((n) => n.humanCodingScheme === code);
  if (found === undefined) throw new Error(`${release.frameworkKey} has no ${code}`);
  return found;
};

/** The humanCodingScheme (or statement, for an uncoded heading) of each node above `code`, nearest first. */
function ancestors(release: Release, code: string): string[] {
  const byUri = new Map(release.content.nodes!.map((n) => [n.uri, n]));
  const parentOf = new Map(release.content.associations!.map((a) => [a.origin.uri, a.destination.uri]));
  const chain: string[] = [];
  for (let uri = parentOf.get(node(release, code).uri); uri !== undefined && byUri.has(uri); uri = parentOf.get(uri)) {
    const parent = byUri.get(uri)!;
    chain.push(parent.humanCodingScheme ?? parent.fullStatement);
  }
  return chain;
}

describe("CCSS publisher text", () => {
  it("adds the high-school mathematics standards under category, domain and cluster", async () => {
    const math = await catalogSeedRelease("ccss-math");
    const standard = node(math, "HSA.SSE.A.2");
    expect(standard.educationLevels).toStrictEqual(["09", "10", "11", "12"]);
    expect(ancestors(math, "HSA.SSE.A.2")).toStrictEqual(["HSA.SSE.A", "HSA.SSE", "HSA"]);
    expect(node(math, "HSA").fullStatement).toBe("Algebra");
    expect(node(math, "HSA.SSE").fullStatement).toBe("Seeing Structure in Expressions");
    // Lettered parts sit under their standard, as CASE Network publishes them.
    expect(ancestors(math, "HSA.SSE.A.1.a")[0]).toBe("HSA.SSE.A.1");
  });

  it("writes superscripts as exponents and keeps the modeling star out of the text", async () => {
    const math = await catalogSeedRelease("ccss-math");
    expect(node(math, "HSA.SSE.A.2").fullStatement).toContain("see x^4 - y^4 as (x^2)^2 - (y^2)^2");
    const modeling = node(math, "HSA.SSE.A.1");
    expect(modeling.fullStatement).toBe("Interpret expressions that represent a quantity in terms of its context.");
    expect(modeling.extensions?.[PUBLISHER_TEXT_EXTENSION]).toMatchObject({ modeling: true });
    expect(modeling.notes).toMatch(/★/);
  });

  it("adds grades 9-12 and the 6-12 literacy standards to ELA/Literacy with their bands", async () => {
    const ela = await catalogSeedRelease("ccss-ela");
    expect(node(ela, "RL.9-10.1").educationLevels).toStrictEqual(["09", "10"]);
    expect(node(ela, "RI.11-12.1").educationLevels).toStrictEqual(["11", "12"]);
    expect(node(ela, "RH.6-8.1").educationLevels).toStrictEqual(["06", "07", "08"]);
    expect(ancestors(ela, "RST.9-10.1")).toStrictEqual(["Key Ideas and Details", "RST.9-10"]);
    expect(node(ela, "WHST.6-8").fullStatement)
      .toBe("Writing Standards for Literacy in History/Social Studies, Science, and Technical Subjects");
    expect(ancestors(ela, "WHST.11-12.1.a")[0]).toBe("WHST.11-12.1");
  });

  it("ships a statement only where the publisher's page and PDF agree, and withholds the rest", async () => {
    for (const key of ["ccss-math", "ccss-ela"] as const) {
      const release = await catalogSeedRelease(key);
      for (const row of ccssPublisherRows(key)) {
        expect(row.statement !== null, row.code).toBe(row.textCheck === "verified-against-pdf");
        const shipped = node(release, row.shortCode);
        expect(shipped.fullStatement, row.code).toBe(row.statement ?? "");
        expect(shipped.fullStatement, row.code).not.toMatch(/<\/?[a-z][^>]*>|&[a-z]+;/i);
        expect(shipped.provenance, row.code).toMatchObject({ source: "derived", sourceUri: row.page });
      }
    }
    // The page reads "(See ... here ...)" where the PDF gives a page number.
    const withheld = node(await catalogSeedRelease("ccss-ela"), "SL.9-10.6");
    expect(withheld.fullStatement).toBe("");
    expect(withheld.notes).toMatch(/withheld/);
    // A placeholder the publisher sets in place of a standard is not shipped as one.
    expect(ccssPublisherRows("ccss-ela").some((row) => row.shortCode === "RL.9-10.8")).toBe(false);
  });
});

describe("C3 indicators", () => {
  it("ships the Dimension 1-4 indicators, each verified, with its grade band", async () => {
    const c3 = await catalogSeedRelease("c3");
    expect(c3Rows()).toHaveLength(283);
    expect(c3Rows().every((row) => row.statement !== null)).toBe(true);
    const civics = node(c3, "D2.Civ.1.K-2");
    expect(civics.fullStatement).toBe("Describe roles and responsibilities of people in authority.");
    expect(civics.educationLevels).toStrictEqual(["KG", "01", "02"]);
    expect(node(c3, "D2.Civ.1.9-12").educationLevels).toStrictEqual(["09", "10", "11", "12"]);
    // A word the PDF breaks across lines ("pow-" / "ers") is joined.
    expect(node(c3, "D2.Civ.1.3-5").fullStatement).toContain("responsibilities and powers of government officials");
    // "Begins in grades 3-5" is a placeholder, not an indicator.
    expect(c3.content.nodes!.some((n) => n.humanCodingScheme === "D2.Civ.4.K-2")).toBe(false);
  });

  it("places each indicator under its dimension, discipline and table category", async () => {
    const c3 = await catalogSeedRelease("c3");
    expect(ancestors(c3, "D2.Civ.1.K-2")).toStrictEqual(["Civic and Political Institutions", "D2.Civ", "D2"]);
    expect(ancestors(c3, "D1.5.6-8")).toStrictEqual(["Determining Helpful Sources", "D1"]);
    expect(node(c3, "D4").fullStatement).toBe("Communicating Conclusions and Taking Informed Action");
    for (const n of c3.content.nodes!) {
      expect(n.provenance.source, n.uri).toBe("derived");
      expect(n.provenance.sourceUri, n.uri).toBe(catalogEntry("c3").transcription!.sources[0]);
    }
  });

  it("carries NCSS's citation and covers social studies K-12 once approved", async () => {
    expect(catalogEntry("c3").license.attribution).toMatch(/^National Council for the Social Studies \(NCSS\), The College, Career, and Civic Life \(C3\) Framework/);
    const admin = { by: PrincipalId.parse("prn_nf-district-admin"), at: "2026-10-21T09:00:00Z" };
    const mirror = new CatalogMirror({ storage: new InMemoryCatalogMirrorStorage(), verifyRelease: async () => true });
    await mirror.select("c3", admin);
    const release = await catalogSeedRelease("c3");
    await mirror.install(release, admin);
    await mirror.approve("c3", release.version, admin);
    const cells = coverageReport(await mirror.selections()).cells.filter((c) => c.subject === "social-studies");
    expect(cells.map((c) => [c.band, c.status])).toStrictEqual([
      ["PK", "gap"],
      ["K-2", "covered"],
      ["3-5", "covered"],
      ["6-8", "covered"],
      ["9-12", "covered"],
    ]);
  });
});
