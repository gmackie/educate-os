// The dry run beyond F03's first cut: pack versions selected by range and pinned in revisions,
// the migrations a change runs, rollback to a version the registry no longer offers, and the
// cost ceiling a change implies.
import { PrincipalId, type ConfigurationRevision } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import { describe, expect, it } from "vitest";
import {
  SHIPPED_PACK_DEFINITIONS,
  createCapabilityRegistry,
  createDraftRevision,
  createRollbackRevision,
  planConfigurationChange,
  type CapabilityRegistry,
  type PackDefinition,
} from "../src/index.ts";
import { NF, northfieldDocument } from "./support.ts";

const ADMIN = PrincipalId.parse("prn_nf-district-admin");

const coreLearning = SHIPPED_PACK_DEFINITIONS.find((d) => d.manifest.id === "core-learning")!;
/** A later core-learning that adds a migration. */
const coreLearning11: PackDefinition = {
  ...coreLearning,
  manifest: { ...coreLearning.manifest, version: "1.1.0", migrations: ["0001-academic-records", "0002-section-codes"] },
};

function registryOf(definitions: readonly PackDefinition[]): CapabilityRegistry {
  const result = createCapabilityRegistry(definitions);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.registry;
}

const BOTH_VERSIONS = registryOf([...SHIPPED_PACK_DEFINITIONS, coreLearning11]);
/** The registry after core-learning 1.0.0 was withdrawn. */
const ONLY_NEWER = registryOf([...SHIPPED_PACK_DEFINITIONS.filter((d) => d !== coreLearning), coreLearning11]);

async function draft(registry: CapabilityRegistry, document: unknown, previous?: ConfigurationRevision): Promise<ConfigurationRevision> {
  const result = await createDraftRevision({ document, registry, actorPrincipalId: ADMIN, ...(previous ? { previous } : {}) });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.revision;
}

function pinnedCore(range: string) {
  const document = northfieldDocument();
  document.modules["core-learning"] = { state: "enabled", version: range };
  return document;
}

const plan = (registry: CapabilityRegistry, current: ConfigurationRevision | undefined, next: ConfigurationRevision) =>
  planConfigurationChange({ ...(current ? { current } : {}), next, directory: NORTHFIELD, registry });

describe("versions and migrations", () => {
  it("pins the version a range selects, and the default version without one", async () => {
    const older = await draft(BOTH_VERSIONS, pinnedCore("~1.0.0"));
    expect((older.desired.modules as Record<string, { version: string }>)["core-learning"]!.version).toBe("1.0.0");
    const latest = await draft(BOTH_VERSIONS, northfieldDocument());
    expect((latest.desired.modules as Record<string, { version: string }>)["core-learning"]!.version).toBe("1.1.0");

    const unsatisfiable = await createDraftRevision({ document: pinnedCore("^2.0.0"), registry: BOTH_VERSIONS, actorPrincipalId: ADMIN });
    expect(unsatisfiable.ok).toBe(false);
    if (!unsatisfiable.ok) {
      expect(unsatisfiable.problems).toContainEqual({
        code: "no-version-in-range",
        path: "/modules/core-learning/version",
        message: "no version of core-learning matches ^2.0.0; available: 1.0.0, 1.1.0",
      });
    }
  });

  it("reports the migrations an install and an upgrade run, and what a downgrade leaves applied", async () => {
    const first = await draft(BOTH_VERSIONS, pinnedCore("~1.0.0"));
    const installed = plan(BOTH_VERSIONS, undefined, first);
    expect(installed.migrations.find((m) => m.capabilityId === "core-learning")).toEqual({
      capabilityId: "core-learning",
      toVersion: "1.0.0",
      run: ["0001-academic-records"],
      notReverted: [],
    });

    const upgraded = await draft(BOTH_VERSIONS, pinnedCore("^1.1.0"), first);
    const upgrade = plan(BOTH_VERSIONS, first, upgraded);
    expect(upgrade.packs.find((p) => p.capabilityId === "core-learning")!.changes).toEqual(["version-changed"]);
    expect(upgrade.migrations).toEqual([
      { capabilityId: "core-learning", fromVersion: "1.0.0", toVersion: "1.1.0", run: ["0002-section-codes"], notReverted: [] },
    ]);

    const rollback = await createRollbackRevision({ target: first, head: upgraded, history: [first, upgraded], actorPrincipalId: ADMIN });
    expect(plan(BOTH_VERSIONS, upgraded, rollback.revision).migrations).toEqual([
      { capabilityId: "core-learning", fromVersion: "1.1.0", toVersion: "1.0.0", run: [], notReverted: ["0002-section-codes"] },
    ]);
  });

  it("flags a rollback target whose pinned version the registry no longer offers", async () => {
    const first = await draft(BOTH_VERSIONS, pinnedCore("~1.0.0"));
    const upgraded = await draft(BOTH_VERSIONS, pinnedCore("^1.1.0"), first);
    const rollback = await createRollbackRevision({ target: first, head: upgraded, history: [first, upgraded], actorPrincipalId: ADMIN });

    const result = plan(ONLY_NEWER, upgraded, rollback.revision);
    expect(result.problems).toEqual([{
      code: "pack-version-unavailable",
      path: "/modules/core-learning/version",
      message: "core-learning 1.0.0 is pinned but no longer available; available: 1.1.0",
    }]);
    expect(result.migrations).toEqual([]);
    // With the version still offered, the same rollback plans cleanly.
    expect(plan(BOTH_VERSIONS, upgraded, rollback.revision).problems).toEqual([]);
  });
});

/** Active principals actively enrolled in any of `offerings`. */
function enrolledIn(offerings: readonly string[]): Set<string> {
  const active = new Set(NORTHFIELD.principals.filter((p) => p.status === "active").map((p) => p.id as string));
  return new Set(NORTHFIELD.enrollments
    .filter((e) => e.status === "active" && offerings.includes(e.offeringId) && active.has(e.principalId))
    .map((e) => e.principalId as string));
}

function withAssessmentAi(aiFeedback: boolean) {
  const document = northfieldDocument();
  document.profile = "us-k12-standard";
  document.policies = { ai: { monthlyCapCentsPerPrincipal: 300 } };
  document.overrides = [{ scope: NF.eng9, policies: { ai: { monthlyCapCentsPerPrincipal: 100 } } }];
  delete document.curriculum;
  document.modules = { "core-learning": "enabled", "assessment-ci": { state: "enabled", config: { aiFeedback } } };
  return document;
}

describe("cost estimate", () => {
  it("bounds AI spend by each reached person's highest effective cap, and counts no AI where none is configured", async () => {
    const off = await draft(BOTH_VERSIONS, withAssessmentAi(false));
    const on = await draft(BOTH_VERSIONS, withAssessmentAi(true), off);
    const result = plan(BOTH_VERSIONS, off, on);

    const bio = enrolledIn(["off_nf-bio-fall-p2"]);
    const eng9 = enrolledIn(["off_nf-eng9-fall-p3"]);
    // Someone in both classes is capped at the higher of the two caps.
    const ceiling = [...new Set([...bio, ...eng9])].reduce((sum, p) => sum + (bio.has(p) ? 300 : 100), 0);
    expect(result.cost).toMatchObject({
      aiPrincipals: new Set([...bio, ...eng9]).size,
      aiMonthlyCeilingCents: ceiling,
      previousAiMonthlyCeilingCents: 0,
    });
    expect(ceiling).toBeGreaterThan(0);
    expect(result.cost.packs.find((p) => p.capabilityId === "assessment-ci")).toEqual({
      capabilityId: "assessment-ci",
      costDrivers: ["runs per submission", "sandbox minutes"],
      principals: new Set([...bio, ...eng9]).size,
      usesAi: true,
    });
  });

  it("counts no AI ceiling where the floor disables AI spending", async () => {
    const document = withAssessmentAi(true);
    document.policies = { ai: { spending: "disabled" } };
    const result = plan(BOTH_VERSIONS, undefined, await draft(BOTH_VERSIONS, document));
    expect(result.cost.aiMonthlyCeilingCents).toBe(0);
    expect(result.cost.aiPrincipals).toBe(0);
    expect(result.cost.principals).toBeGreaterThan(0);
  });
});
