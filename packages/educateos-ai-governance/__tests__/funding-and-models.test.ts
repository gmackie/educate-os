import { describe, expect, it } from "vitest";
import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import { DistrictId, PrincipalId, TermId } from "@educateos/contracts";
import { allowedModels, FundingPoolSet, resolveFunding, routeModel } from "../src/index.ts";
import {
  AMARA,
  BIO_FALL,
  BIO_SPRING,
  CATALOG,
  DMITRI,
  ENG9,
  FLOOR,
  GEMINI,
  MATH7,
  MINI,
  NF,
  northfieldPools,
  OPUS,
  PERSONAL,
  SONNET,
  CHIDI,
} from "./setup.ts";

const pools = northfieldPools();

function poolIds(result: ReturnType<typeof resolveFunding>) {
  return result.ok ? result.pools.map((pool) => pool.id) : result.reason;
}

describe("funding pool resolution", () => {
  it("funds a course request from the pools containing the offering, narrowest first", () => {
    expect(poolIds(resolveFunding(NORTHFIELD, pools, [], AMARA, BIO_FALL))).toEqual(["fpl_nf-bio-fall", "fpl_nf-high"]);
    // English 9 has no class pool, so only the school pool funds it.
    expect(poolIds(resolveFunding(NORTHFIELD, pools, [], AMARA, ENG9))).toEqual(["fpl_nf-high"]);
  });

  it("never lets a course pool fund a personal request, or the personal pool a course one", () => {
    expect(poolIds(resolveFunding(NORTHFIELD, pools, [], AMARA, PERSONAL))).toEqual(["fpl_nf-personal"]);
    const withoutPersonal = pools.filter((pool) => pool.purpose === "course");
    expect(poolIds(resolveFunding(NORTHFIELD, withoutPersonal, [], AMARA, PERSONAL))).toBe("no-funding-pool");
    const onlyPersonal = pools.filter((pool) => pool.purpose === "personal");
    expect(poolIds(resolveFunding(NORTHFIELD, onlyPersonal, [], AMARA, BIO_FALL))).toBe("no-funding-pool");
  });

  it("refuses course funding without an active enrollment in that offering", () => {
    // Dmitri's English 9 enrollment is inactive; Chidi was never in Biology.
    expect(poolIds(resolveFunding(NORTHFIELD, pools, [], DMITRI, ENG9))).toBe("not-enrolled");
    expect(poolIds(resolveFunding(NORTHFIELD, pools, [], CHIDI, BIO_FALL))).toBe("not-enrolled");
    // Chidi's Math 7 class is in a school with no course pool.
    expect(poolIds(resolveFunding(NORTHFIELD, pools, [], CHIDI, MATH7))).toBe("no-funding-pool");
  });

  it("funds nothing from a completed term's course pool", () => {
    // Amara is still enrolled in spring Biology, and its pool still has money.
    expect(poolIds(resolveFunding(NORTHFIELD, pools, [], AMARA, BIO_SPRING))).toBe("term-closed");
  });

  it("stops course funding on a term-closed event even if the directory still says active", () => {
    const closed = [{ type: "term.closed" as const, districtId: NF, termId: TermId.parse("trm_nf-2026-fall"), closedAt: "2027-01-22T23:00:00.000Z" }];
    expect(poolIds(resolveFunding(NORTHFIELD, pools, closed, AMARA, BIO_FALL))).toBe("term-closed");
    // Personal funding does not depend on any term.
    expect(poolIds(resolveFunding(NORTHFIELD, pools, closed, AMARA, PERSONAL))).toEqual(["fpl_nf-personal"]);
  });

  it("refuses principals from another district or not in the directory", () => {
    const riverbendTeacher = { principalId: PrincipalId.parse("prn_rb-morgan-lee"), districtId: DistrictId.parse("dst_riverbend") };
    expect(poolIds(resolveFunding(NORTHFIELD, pools, [], riverbendTeacher, BIO_FALL))).toBe("cross-district");
    // A Riverbend pool set never funds a Northfield principal, even when handed to the resolver.
    expect(poolIds(resolveFunding(RIVERBEND, pools, [], riverbendTeacher, PERSONAL))).toBe("no-funding-pool");
    const ghost = { principalId: PrincipalId.parse("prn_nf-nobody"), districtId: NF };
    expect(poolIds(resolveFunding(NORTHFIELD, pools, [], ghost, PERSONAL))).toBe("unknown-principal");
  });

  it("rejects pool configurations that would make funding ambiguous", () => {
    const personal = pools.find((pool) => pool.purpose === "personal")!;
    expect(FundingPoolSet.safeParse([...pools, { ...personal, id: "fpl_nf-personal-2" }]).success).toBe(false);
    expect(FundingPoolSet.safeParse([...pools, { ...personal }]).success).toBe(false);
    const schoolPersonal = { ...personal, scope: { level: "school", districtId: NF, schoolId: "sch_nf-high" } };
    expect(FundingPoolSet.safeParse([schoolPersonal]).success).toBe(false);
    const otherDistrict = { ...personal, id: "fpl_rb-personal", scope: { level: "district", districtId: "dst_riverbend" } };
    expect(FundingPoolSet.safeParse([personal, otherDistrict]).success).toBe(false);
  });
});

describe("model policy", () => {
  const coursePools = pools.filter((pool) => pool.id === "fpl_nf-bio-fall" || pool.id === "fpl_nf-high");

  it("routes the requested model to the pools that pay for it", () => {
    const route = routeModel(SONNET, { policy: FLOOR, catalog: CATALOG, pools: coursePools });
    expect(route.ok && route.pools.map((pool) => pool.id)).toEqual(["fpl_nf-bio-fall", "fpl_nf-high"]);
    // A hidden model still runs, but only the class pool allows this one.
    const hidden = routeModel(MINI, { policy: FLOOR, catalog: CATALOG, pools: coursePools });
    expect(hidden.ok && hidden.pools.map((pool) => pool.id)).toEqual(["fpl_nf-bio-fall"]);
  });

  it("refuses with a reason, never by substituting another model", () => {
    const input = { policy: FLOOR, catalog: CATALOG, pools: coursePools };
    expect(routeModel(GEMINI, input)).toEqual({ ok: false, reason: "model-disabled" });
    expect(routeModel(OPUS, input)).toEqual({ ok: false, reason: "model-not-allowed" });
    expect(routeModel({ provider: "anthropic", modelId: "unlisted" }, input)).toEqual({ ok: false, reason: "model-unknown" });
    expect(routeModel(SONNET, { ...input, policy: { ...FLOOR, aiSpending: "disabled" } }))
      .toEqual({ ok: false, reason: "ai-spending-disabled" });
  });

  it("derives the allowed models and providers from policy and pool allowlists", () => {
    const allowed = allowedModels({ policy: FLOOR, catalog: CATALOG, pools: coursePools });
    expect(allowed.models.map((model) => model.modelId)).toEqual([SONNET.modelId, MINI.modelId]);
    expect(allowed.providers).toEqual(["anthropic", "openai"]);
    expect(allowedModels({ policy: { ...FLOOR, aiSpending: "disabled" }, catalog: CATALOG, pools: coursePools }))
      .toEqual({ models: [], providers: [] });
  });
});
