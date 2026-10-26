import { describe, expect, it } from "vitest";
import {
  CasePackage,
  type FrameworkRelease,
  type Provenance,
  caseToPlayTrekPackage,
  decodeCasePackage,
  encodeCasePackage,
  playTrekToCasePackage,
} from "../src/index.ts";
import minimal from "./fixtures/case-1.1-minimal.json" with { type: "json" };
import earthScience from "./fixtures/case-1.1-synthetic-earth-science.json" with { type: "json" };
import playTrekShaped from "./fixtures/playtrek-shaped-synthetic-sel.json" with { type: "json" };

const official: Provenance = {
  source: "official",
  sourceUri: "https://case.registry.example/ims/case/v1p1/CFPackages/framework",
  retrievedAt: "2026-10-01T00:00:00Z",
  sourceRevision: "2026.1",
};

/** A fresh copy, so a test can never pass because a codec handed back its input object. */
const copy = <T>(value: T): T => structuredClone(value);

const CASE_CORPUS = { "earth science (full CASE 1.1)": earthScience, "minimal": minimal } as const;

describe("CASE 1.1 compatibility corpus", () => {
  for (const [name, fixture] of Object.entries(CASE_CORPUS)) {
    it(`${name}: encode(decode(package)) is the package`, () => {
      const release = decodeCasePackage(copy(fixture), official);
      expect(encodeCasePackage(release)).toStrictEqual(fixture);
    });

    it(`${name}: decode(encode(release)) is the release`, () => {
      const release = decodeCasePackage(copy(fixture), official);
      expect(decodeCasePackage(encodeCasePackage(release), official)).toStrictEqual(release);
    });
  }

  it("keeps identifiers, URIs and link titles verbatim, including letter case", () => {
    const release = decodeCasePackage(copy(earthScience), official);
    const upper = earthScience.CFItems[2]!;
    expect(upper.identifier).toBe(upper.identifier.toUpperCase());
    expect(release.nodes?.[2]).toMatchObject({ identifier: upper.identifier, uri: upper.uri });
    expect(release.framework).toMatchObject({
      uri: earthScience.CFDocument.uri,
      identifier: earthScience.CFDocument.identifier,
      packageLink: earthScience.CFDocument.CFPackageURI,
    });
  });

  it("keeps composite grade bands as published instead of flattening them", () => {
    const release = decodeCasePackage(copy(earthScience), official);
    const levels = release.nodes?.map((node) => node.educationLevels);
    expect(levels).toEqual([["09", "10", "11", "12"], ["9-12"], ["KG", "01", "02"], ["9-12"]]);
  });

  it("keeps unknown association types as opaque and writes them back unchanged", () => {
    const release = decodeCasePackage(copy(earthScience), official);
    const opaque = release.associations?.filter((a) => a.relation === "opaque").map((a) => a.opaqueType);
    expect(opaque).toEqual(["ext:example.alignsToCareer", "covers"]);
    const types = encodeCasePackage(release).CFAssociations?.map((a) => a.associationType);
    expect(types).toEqual(earthScience.CFAssociations.map((a) => a.associationType));
  });

  it("records CASE associations as publisher assertions, so a published exactMatchOf stays exact", () => {
    const release = decodeCasePackage(copy(earthScience), official);
    const exact = release.associations?.find((a) => a.relation === "exact");
    expect(exact?.evidence).toEqual([{ basis: "publisher-assertion", sourceUri: exact?.uri }]);
    expect(release.framework.provenance).toEqual(official);
    expect(release.nodes?.every((node) => node.provenance.source === "official")).toBe(true);
  });

  it("writes EducateOS crosswalk relations as ext: types and reads them back", () => {
    const release = decodeCasePackage(copy(earthScience), official);
    const [first, ...rest] = release.associations ?? [];
    const crosswalk: FrameworkRelease = {
      ...release,
      associations: [{ ...first!, relation: "broader" }, ...rest],
    };
    const encoded = encodeCasePackage(crosswalk);
    expect(encoded.CFAssociations?.[0]?.associationType).toBe("ext:educateos.broader");
    expect(decodeCasePackage(encoded, official).associations?.[0]?.relation).toBe("broader");

    // A package written before the EducateOS rename names the type `ext:schoolos.broader` (SCHO-232). (rename-educateos: keep)
    const legacy = structuredClone(encoded);
    legacy.CFAssociations![0]!.associationType = "ext:schoolos.broader"; // rename-educateos: keep
    expect(decodeCasePackage(legacy, official).associations?.[0]?.relation).toBe("broader");
  });

  it("refuses to encode an opaque type that would read back as an interpreted relation", () => {
    const release = decodeCasePackage(copy(earthScience), official);
    const [first, ...rest] = release.associations ?? [];
    const forged: FrameworkRelease = {
      ...release,
      associations: [{ ...first!, relation: "opaque", opaqueType: "exactMatchOf" }, ...rest],
    };
    expect(() => encodeCasePackage(forged)).toThrow(/interpreted relation/);
  });

  it("rejects proprietary fields outside extensions and non-CASE identifiers", () => {
    const extraField = copy(earthScience) as Record<string, unknown>;
    (extraField.CFDocument as Record<string, unknown>).vendorField = "x";
    expect(() => decodeCasePackage(extraField, official)).toThrow(/CFDocument/);

    const badIdentifier = copy(minimal);
    badIdentifier.CFItems[0]!.identifier = "not-a-uuid";
    expect(() => decodeCasePackage(badIdentifier, official)).toThrow(/identifier/);
  });

  it("rejects a release with two nodes at one URI", () => {
    const duplicated = copy(earthScience);
    duplicated.CFItems[1]!.uri = duplicated.CFItems[0]!.uri;
    expect(() => decodeCasePackage(duplicated, official)).toThrow(/duplicate URI/);
  });
});

describe("PlayTrek-shaped data", () => {
  it("converts to CASE 1.1 and into registry records without a PlayTrek database", () => {
    const pkg = playTrekToCasePackage(copy(playTrekShaped));
    expect(CasePackage.safeParse(pkg).success).toBe(true);
    const release = decodeCasePackage(pkg, official);
    expect(release.framework.identifier).toBe(playTrekShaped.CFDocument.id);
    expect(release.nodes?.map((node) => node.educationLevels)).toEqual([["KG", "01", "02"], ["K-2"], ["9-12"]]);
    expect(release.associations?.map((a) => a.relation)).toEqual(["child-of", "child-of", "child-of", "exact", "prerequisite"]);
  });

  it("round-trips through CASE and registry records back to the same PlayTrek shape", () => {
    const release = decodeCasePackage(playTrekToCasePackage(copy(playTrekShaped)), official);
    expect(caseToPlayTrekPackage(encodeCasePackage(release))).toStrictEqual(playTrekShaped);
  });

  it("refuses a parentURI that no isChildOf association backs, instead of inventing one", () => {
    const orphaned = copy(playTrekShaped);
    orphaned.CFAssociations = orphaned.CFAssociations.filter((a) => a.originNodeURI.uri !== orphaned.CFItems[1]!.uri);
    expect(() => playTrekToCasePackage(orphaned)).toThrow(/no matching isChildOf/);
  });

  it("refuses to hand PlayTrek a package its shape would silently truncate", () => {
    // The full fixture has definitions, extensions and ext: types that PlayTrek's shape lacks.
    expect(() => caseToPlayTrekPackage(CasePackage.parse(copy(earthScience)))).toThrow(/PlayTrek/);
  });
});
