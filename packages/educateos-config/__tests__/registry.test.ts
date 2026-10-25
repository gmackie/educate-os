import { CapabilityId } from "@educateos/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SHIPPED_PACK_DEFINITIONS,
  SHIPPED_REGISTRY,
  createCapabilityRegistry,
  resolveDependencies,
  type CapabilityRegistry,
  type PackDefinition,
} from "../src/index.ts";

const id = (value: string) => CapabilityId.parse(value);

function pack(name: string, version: string, dependencies: [string, string][] = [], conflicts: string[] = []): PackDefinition {
  return {
    manifest: {
      id: name,
      version,
      description: `${name} pack`,
      dependencies: dependencies.map(([dependencyId, versionRange]) => ({ id: dependencyId, versionRange })),
      ...(conflicts.length > 0 ? { conflicts } : {}),
      supportedScopes: ["district"],
      permissionScopes: [],
      requiredResources: ["worker"],
      migrations: [],
      probes: [],
      estimatedCostDrivers: [],
    },
    config: z.strictObject({}),
    supportsAdvisory: false,
  };
}

function registryOf(definitions: PackDefinition[]): CapabilityRegistry {
  const result = createCapabilityRegistry(definitions);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.registry;
}

describe("shipped packs", () => {
  it("resolve together with every dependency installed before its dependents", () => {
    const resolution = resolveDependencies(SHIPPED_REGISTRY, [...SHIPPED_REGISTRY.packs.keys()]);
    expect(resolution.problems).toEqual([]);
    expect(resolution.installOrder[0]).toBe("core-learning");
    for (const [position, packId] of resolution.installOrder.entries()) {
      for (const dependency of SHIPPED_REGISTRY.packs.get(packId)!.manifest.dependencies) {
        expect(resolution.installOrder.indexOf(dependency.id), `${dependency.id} before ${packId}`).toBeLessThan(position);
      }
    }
  });

  it("pull in dependencies transitively: content-studio brings the registry, artifacts and core", () => {
    const resolution = resolveDependencies(SHIPPED_REGISTRY, [id("content-studio")]);
    expect(resolution.installOrder).toEqual(["core-learning", "learning-artifacts", "learning-registry", "content-studio"]);
    expect(resolution.dependents.get(id("learning-artifacts"))).toEqual(["content-studio"]);
  });
});

describe("resolveDependencies", () => {
  it("reports every problem at once and withholds an install order", () => {
    const registry = registryOf([
      pack("base", "1.4.0"),
      pack("needs-missing", "1.0.0", [["ghost", "^1.0.0"]]),
      pack("needs-newer", "1.0.0", [["base", "^2.0.0"]]),
      pack("bad-range", "1.0.0", [["base", ">=1.0.0"]]),
      pack("rival-a", "1.0.0", [], ["rival-b"]),
      pack("rival-b", "1.0.0"),
      pack("loop-a", "1.0.0", [["loop-b", "1.0.0"]]),
      pack("loop-b", "1.0.0", [["loop-c", "1.0.0"]]),
      pack("loop-c", "1.0.0", [["loop-a", "1.0.0"]]),
    ]);
    const resolution = resolveDependencies(registry, [
      "needs-missing", "needs-newer", "bad-range", "rival-a", "rival-b", "loop-b", "unheard-of",
    ].map(id));

    expect(resolution.installOrder).toEqual([]);
    expect(resolution.problems).toEqual(expect.arrayContaining([
      { kind: "unknown-capability", capabilityId: "unheard-of" },
      { kind: "missing-dependency", capabilityId: "needs-missing", dependencyId: "ghost", versionRange: "^1.0.0" },
      { kind: "version-mismatch", capabilityId: "needs-newer", dependencyId: "base", versionRange: "^2.0.0", availableVersion: "1.4.0" },
      { kind: "invalid-version-range", capabilityId: "bad-range", dependencyId: "base", versionRange: ">=1.0.0" },
      { kind: "conflict", capabilityId: "rival-a", conflictsWith: "rival-b" },
      { kind: "dependency-cycle", path: ["loop-a", "loop-b", "loop-c", "loop-a"] },
    ]));
    expect(resolution.problems).toHaveLength(6);
  });

  it("finds a conflict declared by either side, and only when both are in the closure", () => {
    const registry = registryOf([pack("a", "1.0.0", [["b", "1.0.0"]]), pack("b", "1.0.0"), pack("c", "1.0.0", [], ["b"])]);
    expect(resolveDependencies(registry, [id("a")]).problems).toEqual([]);
    expect(resolveDependencies(registry, [id("a"), id("c")]).problems).toEqual([
      { kind: "conflict", capabilityId: "b", conflictsWith: "c" },
    ]);
  });

  it("orders independent packs by ID so the plan is the same every time", () => {
    const registry = registryOf([pack("zeta", "1.0.0"), pack("alpha", "1.0.0"), pack("mid", "1.0.0", [["zeta", "^1.0.0"]])]);
    expect(resolveDependencies(registry, [id("mid"), id("alpha")]).installOrder).toEqual(["alpha", "zeta", "mid"]);
  });
});

describe("multi-version packs", () => {
  const registry = registryOf([
    pack("base", "1.0.0"),
    pack("base", "1.4.0"),
    pack("base", "2.0.0"),
    pack("base", "2.1.0-beta.1"),
    pack("old-client", "1.0.0", [["base", "^1.0.0"]]),
    pack("new-client", "1.0.0", [["base", "^2.0.0"]]),
  ]);

  it("offers the newest release by default, never a prerelease", () => {
    expect(registry.packs.get(id("base"))!.manifest.version).toBe("2.0.0");
    expect(registry.versions.get(id("base"))!.map((p) => p.manifest.version)).toEqual(["1.0.0", "1.4.0", "2.0.0", "2.1.0-beta.1"]);
  });

  it("selects the newest version every range on a pack admits", () => {
    const resolution = resolveDependencies(registry, [id("old-client")]);
    expect(resolution.problems).toEqual([]);
    expect(resolution.selected.get(id("base"))!.manifest.version).toBe("1.4.0");
    expect(resolveDependencies(registry, [id("base")], new Map([[id("base"), "~1.0.0"]])).selected.get(id("base"))!.manifest.version)
      .toBe("1.0.0");
  });

  it("reports ranges no version satisfies instead of quietly taking another version", () => {
    const both = resolveDependencies(registry, [id("old-client"), id("new-client")]);
    expect(both.installOrder).toEqual([]);
    // No version admits both ranges, so the default version is taken and the range it misses is reported.
    expect(both.problems).toEqual([
      { kind: "version-mismatch", capabilityId: "old-client", dependencyId: "base", versionRange: "^1.0.0", availableVersion: "2.0.0" },
    ]);
    expect(resolveDependencies(registry, [id("base")], new Map([[id("base"), "^3.0.0"]])).problems).toEqual([
      { kind: "no-version-in-range", capabilityId: "base", versionRange: "^3.0.0", availableVersions: ["1.0.0", "1.4.0", "2.0.0", "2.1.0-beta.1"] },
    ]);
  });
});

describe("createCapabilityRegistry", () => {
  it("rejects a manifest carrying an install script, and duplicates, reporting both", () => {
    const withScript = pack("scripted", "1.0.0");
    (withScript.manifest as Record<string, unknown>).installScript = "curl https://packs.example/run.sh | sh";
    const result = createCapabilityRegistry([pack("dup", "1.0.0"), withScript, pack("dup", "1.1.0"), pack("dup", "1.0.0")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      { kind: "invalid-manifest", index: 1, issues: [expect.stringContaining("installScript")] },
      { kind: "duplicate-capability", capabilityId: "dup", version: "1.0.0" },
    ]);
  });

  it("derives every shipped manifest's JSON Schema from its Zod config", () => {
    for (const definition of SHIPPED_PACK_DEFINITIONS) {
      const shipped = SHIPPED_REGISTRY.packs.get(id(definition.manifest.id))!;
      expect(shipped.manifest.configSchema).toEqual(z.toJSONSchema(definition.config, { io: "input" }));
      // Every setting has a default, so a pack pulled in as a dependency is configured.
      expect(definition.config.safeParse({}).success, definition.manifest.id).toBe(true);
    }
  });
});
