import { describe, expect, it } from "vitest";
import {
  CATALOG,
  CatalogEntry,
  catalogEntry,
  catalogSeedRelease,
  catalogUuid,
  GRADE_BANDS,
  gradeBandsOf,
} from "../src/index.ts";

/** Expects a promise to reject with a EducateOsError of `code`. */
async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "EducateOsError", code });
}

const highSchool = (key: string) => catalogEntry(key).coverage.find((r) => r.band === "9-12")!;

describe("catalog entries", () => {
  it("lists the frameworks the roadmap names, plus the pre-K seeds", () => {
    expect(CATALOG.map((e) => e.key).toSorted()).toStrictEqual(
      ["c3", "casel-5", "ccss-ela", "ccss-math", "head-start-elof", "michigan", "ngss", "teks"],
    );
    expect(Object.fromEntries(CATALOG.map((e) => [e.key, e.status]))).toStrictEqual({
      "ccss-math": "available",
      "ccss-ela": "available",
      "ngss": "pointer-only",
      "c3": "available",
      "casel-5": "available",
      "head-start-elof": "available",
      "teks": "pointer-only",
      "michigan": "pointer-only",
    });
  });

  it("carries licensing metadata and attribution on every framework", () => {
    for (const entry of CATALOG) {
      expect(entry.license.attribution.length, entry.key).toBeGreaterThan(20);
      expect(entry.framework.license?.uri, entry.key).toBe(entry.license.termsUrl);
      expect(URL.parse(entry.license.termsUrl)?.protocol, entry.key).toBe("https:");
    }
    // The CCSS license requires this notice, word for word.
    expect(catalogEntry("ccss-math").license.attribution).toBe(
      "© Copyright 2010. National Governors Association Center for Best Practices and Council of Chief State School Officers. All rights reserved.",
    );
  });

  it("marks catalog metadata as derived, never as the publisher's own record", async () => {
    for (const entry of CATALOG) {
      expect(entry.framework.provenance.source, entry.key).toBe("derived");
      expect(entry.framework.identifier, entry.key).toBe(await catalogUuid(entry.framework.uri));
    }
    const official = { ...catalogEntry("ngss"), framework: { ...catalogEntry("ngss").framework, provenance: { ...catalogEntry("ngss").framework.provenance, source: "official" } } };
    expect(CatalogEntry.safeParse(official).success).toBe(false);
  });

  it("declares every grade band of every subject, so high-school gaps are explicit", () => {
    for (const entry of CATALOG) {
      for (const subject of entry.subjects) {
        expect(entry.coverage.filter((r) => r.subject === subject).map((r) => r.band), `${entry.key}/${subject}`)
          .toStrictEqual([...GRADE_BANDS]);
      }
    }
    expect(highSchool("casel-5")).toMatchObject({ state: "gap", note: expect.stringMatching(/^Gap/) });
    expect(highSchool("michigan").state).toBe("gap");

    const entry = catalogEntry("ccss-ela");
    const withoutHighSchool = { ...entry, coverage: entry.coverage.filter((r) => r.band !== "9-12") };
    expect(CatalogEntry.safeParse(withoutHighSchool).success).toBe(false);
  });

  it("refuses to declare shipped text for a framework whose license does not permit it", () => {
    const entry = catalogEntry("casel-5");
    const withText = { ...entry, coverage: entry.coverage.map((r) => (r.state === "items-without-text" ? { ...r, state: "items" } : r)) };
    expect(CatalogEntry.safeParse(withText).success).toBe(false);

    const pointer = catalogEntry("ngss");
    expect(CatalogEntry.safeParse({ ...pointer, coverage: pointer.coverage.map((r) => ({ ...r, state: "items" })) }).success)
      .toBe(false);
  });

  it("ships no items for pointer-only and gap frameworks", async () => {
    for (const entry of CATALOG.filter((e) => e.status !== "available")) {
      expect(entry.seed, entry.key).toBeUndefined();
      expect(entry.transcription, entry.key).toBeUndefined();
      expect(entry.coverage.every((r) => r.state === "pointer" || r.state === "gap"), entry.key).toBe(true);
      await rejectsWith(catalogSeedRelease(entry.key), "conflict");
    }
    await rejectsWith(catalogSeedRelease("unknown-framework"), "not-found");
  });

  it("declares exactly the bands its shipped items cover", async () => {
    for (const entry of CATALOG.filter((e) => e.status === "available")) {
      const release = await catalogSeedRelease(entry.key);
      const shipped = new Set((release.content.nodes ?? []).flatMap((n) => gradeBandsOf(n.educationLevels)));
      for (const row of entry.coverage) {
        const declaresItems = row.state === "items" || row.state === "items-without-text";
        expect(declaresItems, `${entry.key} ${row.subject}/${row.band}`).toBe(shipped.has(row.band));
      }
    }
  });

  it("produces the same seed release digest every time", async () => {
    const [a, b] = await Promise.all([catalogSeedRelease("ccss-math"), catalogSeedRelease("ccss-math")]);
    expect(a.contentDigest).toBe(b.contentDigest);
    expect(a.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
