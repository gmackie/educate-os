import { PrincipalId } from "@educateos/contracts";
import { describe, expect, it } from "vitest";
import { CatalogMirror, catalogSeedRelease, coverageReport, InMemoryCatalogMirrorStorage } from "../src/index.ts";

const ADMIN = { by: PrincipalId.parse("prn_nf-district-admin"), at: "2026-10-20T09:00:00Z" };

async function districtWith(selected: string[], approved: string[]) {
  const mirror = new CatalogMirror({ storage: new InMemoryCatalogMirrorStorage(), verifyRelease: async () => true });
  for (const key of selected) await mirror.select(key, ADMIN);
  for (const key of approved) {
    const release = await catalogSeedRelease(key);
    await mirror.install(release, ADMIN);
    await mirror.approve(key, release.version, ADMIN);
  }
  return coverageReport(await mirror.selections());
}

const status = (report: Awaited<ReturnType<typeof districtWith>>, subject: string, band: string) =>
  report.cells.find((c) => c.subject === subject && c.band === band)?.status;

describe("coverage report", () => {
  it("reports what approved releases cover, what still needs installing or importing, and the gaps", async () => {
    const report = await districtWith(["ccss-math", "ngss", "casel-5", "ccss-ela"], ["ccss-math", "casel-5"]);

    expect(status(report, "mathematics", "K-2")).toBe("covered");
    expect(status(report, "mathematics", "6-8")).toBe("covered");
    expect(status(report, "mathematics", "9-12")).toBe("covered");
    expect(status(report, "english-language-arts", "3-5")).toBe("install-required");
    expect(status(report, "english-language-arts", "9-12")).toBe("install-required");
    expect(status(report, "science", "9-12")).toBe("import-required");
    expect(status(report, "social-emotional-learning", "K-2")).toBe("text-withheld");
    expect(status(report, "social-emotional-learning", "9-12")).toBe("gap");
    // Nothing selected covers social studies, so every band is flagged.
    expect(report.gaps.filter((c) => c.subject === "social-studies").map((c) => c.band)).toStrictEqual(["PK", "K-2", "3-5", "6-8", "9-12"]);
    expect(report.cells.find((c) => c.subject === "social-studies")?.frameworks).toStrictEqual([]);
  });

  it("takes the best coverage any selected framework gives a band, and lists each framework's part", async () => {
    const report = await districtWith(["ccss-math", "head-start-elof", "teks"], ["head-start-elof"]);
    const preK = report.cells.find((c) => c.subject === "mathematics" && c.band === "PK")!;
    expect(preK.status).toBe("covered");
    expect(preK.frameworks.map((f) => [f.key, f.coverage])).toStrictEqual([
      ["ccss-math", "gap"],
      ["head-start-elof", "covered"],
      ["teks", "import-required"],
    ]);
  });

  it("flags every cell as a gap for a district that selected nothing", async () => {
    const report = await districtWith([], []);
    expect(report.gaps).toHaveLength(report.cells.length);
    expect(report.cells).toHaveLength(25);
  });
});
