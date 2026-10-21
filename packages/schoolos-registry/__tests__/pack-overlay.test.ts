// Curriculum pack overlays (SCHO-42): scoped hide, reorder and pin, and content policies that only
// narrow, applied when a pack is read without ever changing the release.
import { Scope } from "@schoolos/contracts";
import { describe, expect, it } from "vitest";
import {
  applyPackOverlays,
  type ContentPolicy,
  contentPolicyViolations,
  CurriculumPack,
  narrowContentPolicy,
  type PackOverlay,
  ResourceDescriptor,
} from "../src/index.ts";

const derived = {
  source: "derived" as const,
  sourceUri: "https://registry.example/packs/biology",
  retrievedAt: "2026-10-01T00:00:00Z",
  sourceRevision: "1.0.0",
};

const PACK = CurriculumPack.parse({
  id: "pck_biology",
  release: { version: "1.0.0", releasedAt: "2026-10-01T00:00:00Z", contentDigest: `sha256:${"a".repeat(64)}` },
  title: "Synthetic biology",
  audience: { educationLevels: ["09", "10"] },
  units: ["cells", "genetics", "evolution", "ecology"].map((u) => ({ unitId: `unt_${u}`, releaseVersion: "1.0.0" })),
  review: { status: "unreviewed" },
  provenance: derived,
});

const district = Scope.parse({ level: "district", districtId: "dst_northfield" });
const school = Scope.parse({ level: "school", districtId: "dst_northfield", schoolId: "sch_nf-high" });
const offering = Scope.parse({ level: "offering", districtId: "dst_northfield", schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" });
const otherOffering = Scope.parse({ ...offering, offeringId: "off_nf-bio-spring-p4" });
const otherDistrict = Scope.parse({ level: "district", districtId: "dst_riverbend" });

const overlay = (scope: Scope, fields: Partial<PackOverlay>): PackOverlay => ({
  packId: PACK.id,
  scope,
  author: "prn_nf-district-admin" as PackOverlay["author"],
  updatedAt: "2026-10-20T09:00:00Z",
  ...fields,
});

const ids = (units: ReadonlyArray<{ unitId: string }>) => units.map((u) => u.unitId);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("pack overlays", () => {
  it("shows the pack as released when no overlay applies", () => {
    const view = applyPackOverlays(PACK, [], offering);
    expect(view.units).toStrictEqual(PACK.units);
    expect(view).toMatchObject({ hidden: [], contentPolicy: {}, appliedScopes: [], releaseVersion: "1.0.0" });
  });

  it("applies the overlays whose scope contains the reader's, and no others", () => {
    const overlays = [
      overlay(district, { hide: ["unt_ecology" as never] }),
      overlay(otherOffering, { hide: ["unt_cells" as never] }),
      overlay(otherDistrict, { hide: ["unt_genetics" as never] }),
      { ...overlay(district, { hide: ["unt_evolution" as never] }), packId: "pck_chemistry" },
    ];
    const view = applyPackOverlays(PACK, overlays, offering);
    expect(ids(view.units)).toStrictEqual(["unt_cells", "unt_genetics", "unt_evolution"]);
    expect(view.hidden).toStrictEqual(["unt_ecology"]);
    expect(view.appliedScopes).toStrictEqual([district]);
    // The district itself sees only its own overlay too.
    expect(ids(applyPackOverlays(PACK, overlays, district).units)).toStrictEqual(ids(view.units));
  });

  it("never lets a narrower scope show a unit a wider scope hid", () => {
    const view = applyPackOverlays(PACK, [
      overlay(district, { hide: ["unt_ecology" as never] }),
      overlay(offering, { order: ["unt_ecology" as never, "unt_cells" as never], hide: ["unt_genetics" as never] }),
    ], offering);
    expect(ids(view.units)).toStrictEqual(["unt_cells", "unt_evolution"]);
    expect(view.hidden).toStrictEqual(["unt_genetics", "unt_ecology"]);
  });

  it("re-sequences in scope order, each order starting from what the wider scope left", () => {
    const view = applyPackOverlays(PACK, [
      // Listed narrowest first, to show the input order does not matter.
      overlay(offering, { order: ["unt_genetics" as never] }),
      overlay(school, { order: ["unt_ecology" as never, "unt_evolution" as never] }),
    ], offering);
    expect(ids(view.units)).toStrictEqual(["unt_genetics", "unt_ecology", "unt_evolution", "unt_cells"]);
    expect(view.appliedScopes).toStrictEqual([school, offering]);
  });

  it("keeps a pinned unit at the narrowest scope's release", () => {
    const view = applyPackOverlays(PACK, [
      overlay(district, { pin: [{ unitId: "unt_cells" as never, releaseVersion: "0.9.0" }] }),
      overlay(school, { pin: [{ unitId: "unt_cells" as never, releaseVersion: "0.8.0" }, { unitId: "unt_ecology" as never, releaseVersion: "1.1.0" }] }),
    ], offering);
    expect(view.units.find((u) => u.unitId === "unt_cells")?.releaseVersion).toBe("0.8.0");
    expect(view.units.find((u) => u.unitId === "unt_ecology")?.releaseVersion).toBe("1.1.0");
    expect(view.units.find((u) => u.unitId === "unt_genetics")?.releaseVersion).toBe("1.0.0");
  });

  it("reports entries naming units the release does not contain, and changes nothing for them", () => {
    const view = applyPackOverlays(PACK, [overlay(school, { hide: ["unt_retired" as never], pin: [{ unitId: "unt_new" as never, releaseVersion: "2.0.0" }] })], offering);
    expect(view.units).toStrictEqual(PACK.units);
    expect(view.ignored).toStrictEqual([
      { scope: school, field: "hide", unitId: "unt_retired" },
      { scope: school, field: "pin", unitId: "unt_new" },
    ]);
  });

  it("refuses two applicable overlays on one scope, and malformed overlays", () => {
    expect(() => applyPackOverlays(PACK, [overlay(school, {}), overlay(school, { hide: ["unt_cells" as never] })], offering))
      .toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() => applyPackOverlays(PACK, [overlay(school, { hide: ["unt_cells" as never, "unt_cells" as never] })], offering))
      .toThrow(expect.objectContaining({ code: "validation-failed" }));
    expect(() => applyPackOverlays(PACK, [{ ...overlay(school, {}), extra: true }], offering))
      .toThrow(expect.objectContaining({ code: "validation-failed" }));
  });

  it("never changes the pack release or the overlays it reads", () => {
    const pack = deepFreeze(structuredClone(PACK));
    const overlays = deepFreeze([
      overlay(district, { hide: ["unt_ecology" as never], contentPolicy: { requireApprovedReview: true } }),
      overlay(offering, { order: ["unt_evolution" as never], pin: [{ unitId: "unt_cells" as never, releaseVersion: "0.9.0" }] }),
    ]);
    const before = structuredClone({ pack, overlays });
    applyPackOverlays(pack, overlays, offering);
    expect({ pack, overlays }).toStrictEqual(before);
  });
});

describe("content policies", () => {
  it("only narrow as scopes get narrower", () => {
    const view = applyPackOverlays(PACK, [
      overlay(district, { contentPolicy: { allowedRightsModes: ["link", "embed"], blockedHazards: ["flashing"] } }),
      overlay(school, { contentPolicy: { allowedRightsModes: ["embed", "licensed-copy"], requireVerifiedLicense: true } }),
      overlay(offering, { contentPolicy: { blockedResourceKinds: ["lti-tool"], blockedHazards: ["motion-simulation"] } }),
    ], offering);
    expect(view.contentPolicy).toStrictEqual({
      allowedRightsModes: ["embed"],
      requireVerifiedLicense: true,
      blockedResourceKinds: ["lti-tool"],
      blockedHazards: ["flashing", "motion-simulation"],
    });
  });

  it("cannot be written to relax a requirement", () => {
    const relaxed = { ...overlay(school, {}), contentPolicy: { requireVerifiedLicense: false } };
    expect(() => applyPackOverlays(PACK, [relaxed], offering)).toThrow(expect.objectContaining({ code: "validation-failed" }));
    const strict: ContentPolicy = { requireVerifiedLicense: true };
    expect(narrowContentPolicy(strict, {})).toStrictEqual(strict);
    expect(narrowContentPolicy({}, strict)).toStrictEqual(strict);
  });

  it("names every rule a resource breaks", () => {
    const resource = ResourceDescriptor.parse({
      id: "rsc_cell-video",
      release: PACK.release,
      kind: "video",
      title: "Synthetic cell video",
      locator: "https://media.example/cells",
      license: { name: "Example license", permittedUses: ["link"], verification: { status: "claimed" } },
      audience: {},
      accessibility: { features: ["captions"], hazards: ["flashing"] },
      alignments: [],
      review: { status: "unreviewed" },
      provenance: derived,
    });
    expect(contentPolicyViolations({}, resource)).toStrictEqual([]);
    expect(contentPolicyViolations({
      allowedRightsModes: ["embed"],
      requireVerifiedLicense: true,
      requireApprovedReview: true,
      blockedResourceKinds: ["video"],
      blockedHazards: ["flashing"],
    }, resource)).toStrictEqual(["rights-mode-not-allowed", "license-unverified", "review-not-approved", "kind-blocked", "hazard-blocked"]);
    expect(contentPolicyViolations({ allowedRightsModes: ["link", "embed"] }, resource)).toStrictEqual([]);
  });
});
