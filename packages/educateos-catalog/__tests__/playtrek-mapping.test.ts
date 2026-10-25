import { decodeCasePackage, encodeCasePackage } from "@educateos/registry";
import { describe, expect, it } from "vitest";
import {
  catalogEntry,
  catalogSeedRelease,
  PLAYTREK_SEEDED_FRAMEWORKS,
  playTrekSeedRelease,
  playTrekSeedRows,
  PUBLISHER_TEXT_EXTENSION,
  SEED_EXTENSION,
} from "../src/index.ts";

const nodeByCode = async (key: string, code: string) => {
  const release = await catalogSeedRelease(key);
  const node = release.content.nodes?.find((n) => n.humanCodingScheme === code);
  if (node === undefined) throw new Error(`${key} has no ${code}`);
  return node;
};

describe("PlayTrek seed mapping", () => {
  it("marks every seed record derived, with PlayTrek as the transcriber, and none official", async () => {
    for (const key of PLAYTREK_SEEDED_FRAMEWORKS) {
      const { content } = await catalogSeedRelease(key);
      const records = [...(content.nodes ?? []), ...(content.associations ?? [])];
      expect(records.length, key).toBeGreaterThan(0);
      for (const record of records) expect(record.provenance.source, record.uri).toBe("derived");
      // CCSS releases also carry the publisher-text records, which say so instead.
      const seeded = (content.nodes ?? []).filter((node) => node.extensions?.[PUBLISHER_TEXT_EXTENSION] === undefined);
      for (const node of seeded) {
        expect(node.extensions?.[SEED_EXTENSION], node.uri).toMatchObject({ transcriber: "PlayTrek" });
        expect(node.notes, node.uri).toMatch(/PlayTrek/);
      }
    }
  });

  it("restores the published education levels instead of PlayTrek's single numeric grade", async () => {
    // As CASE Network publishes CCSS: one CEDS code per grade.
    expect((await nodeByCode("ccss-math", "K.CC.A.1")).educationLevels).toStrictEqual(["KG"]);
    expect((await nodeByCode("ccss-math", "6.RP.A.1")).educationLevels).toStrictEqual(["06"]);
    expect((await nodeByCode("ccss-ela", "RL.8.1")).educationLevels).toStrictEqual(["08"]);
    // PlayTrek stored a CASEL K-2 indicator as grade 0; the band stays a list of its grades.
    expect((await nodeByCode("casel-5", "SEL.SA.K2.1")).educationLevels).toStrictEqual(["KG", "01", "02"]);
    expect((await nodeByCode("casel-5", "SEL.RDM.68.1")).educationLevels).toStrictEqual(["06", "07", "08"]);
    // Pre-K was -1 in PlayTrek.
    expect((await nodeByCode("head-start-elof", "P-MATH 1")).educationLevels).toStrictEqual(["PK"]);
    // A grouping carries the levels of everything under it.
    expect((await nodeByCode("casel-5", "SEL.SA")).educationLevels).toStrictEqual(["KG", "01", "02", "03", "04", "05", "06", "07", "08"]);
  });

  it("round-trips grade bands through CASE exactly as published", async () => {
    for (const key of PLAYTREK_SEEDED_FRAMEWORKS) {
      const { content } = await catalogSeedRelease(key);
      const pkg = encodeCasePackage(content);
      const levels = new Map(content.nodes!.map((n) => [n.uri, n.educationLevels]));
      for (const item of pkg.CFItems ?? []) expect(item.educationLevel, item.uri).toStrictEqual(levels.get(item.uri));
      const decoded = decodeCasePackage(pkg, content.nodes![0]!.provenance);
      expect(decoded.nodes!.map((n) => n.educationLevels)).toStrictEqual(content.nodes!.map((n) => n.educationLevels));
    }
  });

  it("links each record to its parent with exactly one child-of association, ending at the framework", async () => {
    for (const key of PLAYTREK_SEEDED_FRAMEWORKS) {
      const { content, frameworkKey } = await catalogSeedRelease(key);
      const uris = new Set(content.nodes!.map((n) => n.uri));
      const frameworkUri = catalogEntry(frameworkKey).framework.uri;
      for (const node of content.nodes!) {
        const parents = content.associations!.filter((a) => a.origin.uri === node.uri);
        expect(parents.map((a) => a.relation), node.uri).toStrictEqual(["child-of"]);
        expect(uris.has(parents[0]!.destination.uri) || parents[0]!.destination.uri === frameworkUri, node.uri).toBe(true);
      }
    }
    const standard = await nodeByCode("ccss-math", "K.CC.A.1");
    const { content } = await catalogSeedRelease("ccss-math");
    const cluster = content.associations!.find((a) => a.origin.uri === standard.uri)!.destination;
    expect(cluster.uri).toBe("urn:educateos:catalog:ccss-math:CCSS.MATH.CONTENT.K.CC.A");
  });

  it("ships CCSS text only where it is the publisher's: PlayTrek's where it matched, the publisher's own where not", async () => {
    expect((await nodeByCode("ccss-math", "K.CC.A.1")).fullStatement).toBe("Count to 100 by ones and by tens.");
    // PlayTrek wrote "as used in a text"; the row now carries the published standard instead.
    const replaced = await nodeByCode("ccss-ela", "RL.3.4");
    expect(replaced.fullStatement).toBe("Determine the meaning of words and phrases as they are used in a text, distinguishing literal from nonliteral language.");
    expect(replaced.extensions?.[SEED_EXTENSION]).toMatchObject({ textCheck: "replaced-from-publisher" });
    expect(replaced.notes).toMatch(/publisher's own statement/);
    // Superscripts the old reference dropped are kept as exponents.
    expect((await nodeByCode("ccss-math", "8.EE.A.1")).fullStatement).toMatch(/3\^2 × 3\^\(-5\) = 3\^\(-3\) = 1\/3\^3 = 1\/27\./);
    // The publisher's page and PDF disagree here (the page says "here" for the PDF's page reference).
    const withheld = await nodeByCode("ccss-ela", "SL.1.6");
    expect(withheld.fullStatement).toBe("");
    expect(withheld.extensions?.[SEED_EXTENSION]).toMatchObject({ textCheck: "differs" });

    for (const key of ["ccss-math", "ccss-ela"] as const) {
      for (const row of playTrekSeedRows(key)) {
        expect(row.statement !== null, row.code).toBe(["verbatim", "formatting-only", "replaced-from-publisher"].includes(row.textCheck));
      }
    }
  });

  it("ships no CASEL-aligned indicator text or sub-competency labels", async () => {
    const { content } = await catalogSeedRelease("casel-5");
    const indicators = content.nodes!.filter((n) => n.itemType === "Indicator");
    expect(indicators.length).toBe(72);
    for (const node of indicators) expect(node.fullStatement, node.uri).toBe("");
    expect(playTrekSeedRows("casel-5").every((r) => r.statement === null && r.cluster === null)).toBe(true);
  });

  it("fails rather than guess when a row's code and grade disagree", async () => {
    const [row, ...rest] = playTrekSeedRows("ccss-math");
    const framework = catalogEntry("ccss-math").framework;
    await expect(playTrekSeedRelease("ccss-math", framework, [{ ...row!, gradeLevel: row!.gradeLevel + 1 }, ...rest]))
      .rejects.toMatchObject({ code: "validation-failed" });
    await expect(playTrekSeedRelease("ccss-math", framework, [row!, row!]))
      .rejects.toMatchObject({ code: "validation-failed" });
  });
});
