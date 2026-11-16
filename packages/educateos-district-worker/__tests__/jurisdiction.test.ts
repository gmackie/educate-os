// The district's data jurisdiction (SCHO-374, ADR-0015): the var is read strictly, and the namespace
// is restricted only when the district has one.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { inJurisdiction, readDataJurisdiction } from "../src/jurisdiction.ts";

describe("DATA_JURISDICTION", () => {
  it("is unpinned when unset or empty, and us when it says us", () => {
    expect(readDataJurisdiction(undefined)).toBeUndefined();
    expect(readDataJurisdiction("")).toBeUndefined();
    expect(readDataJurisdiction("us")).toBe("us");
  });

  it("refuses anything else rather than guessing where the data lives", () => {
    for (const value of ["US", "eu", "fedramp", "wnam", " us"]) {
      expect(() => readDataJurisdiction(value)).toThrow(/DATA_JURISDICTION must be unset or one of us/);
    }
  });
});

describe("inJurisdiction", () => {
  it("restricts the namespace only when there is a jurisdiction", () => {
    const asked: string[] = [];
    const namespace = { name: "unpinned", jurisdiction: (j: string) => (asked.push(j), { ...namespace, name: j }) };
    expect(inJurisdiction(namespace, undefined)).toBe(namespace);
    expect(inJurisdiction(namespace, "us").name).toBe("us");
    expect(asked).toEqual(["us"]);
  });

  it("fails closed in local workerd, which does not implement jurisdictions, and leaves the unpinned namespace working", () => {
    // Cloudflare does: there a `us` namespace names a different object than the unpinned one (ADR-0015).
    // Locally the restriction throws rather than quietly naming an unpinned object, so a pinned
    // district cannot run in dev or tests, and DATA_JURISDICTION stays unset there.
    expect(() => inJurisdiction(exports.DistrictObject, "us")).toThrow(/Jurisdiction restrictions are not implemented in workerd/);
    expect(inJurisdiction(exports.DistrictObject, undefined).idFromName("jurisdiction-test").jurisdiction).toBeUndefined();
  });
});
