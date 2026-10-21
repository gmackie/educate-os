import {
  CapabilityId,
  PolicySettings,
  resolvePolicy,
  scopeContains,
  type PolicyLayer,
  type PolicyOverrides,
} from "@schoolos/contracts";
import type { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import {
  DEFAULTS_PROFILES,
  DistrictConfigDocument,
  toPolicyOverrides,
  type DesiredModule,
  type DesiredState,
  type ModuleEntry,
  type ModuleState,
  type NarrowerScope,
} from "./document.ts";
import { resolveDependencies, type CapabilityRegistry, type ResolutionProblem } from "./registry.ts";
import { findSecrets, pointerSegment } from "./secrets.ts";

/** What a {@link ConfigProblem} is about. */
export type ConfigProblemCode =
  | "invalid-document"
  | "invalid-yaml"
  | "secret-in-config"
  | "invalid-pack-config"
  | "advisory-unsupported"
  | "dependency-disabled"
  | "curriculum-needs-learning-registry"
  | "scope-outside-district"
  | "duplicate-override"
  | "policy-violation"
  | ResolutionProblem["kind"];

/**
 * One reason a document does not compile. `path` is a JSON Pointer into the document. Messages
 * name fields and values from the schema vocabulary only, never a value the scan took for a secret.
 */
export interface ConfigProblem {
  /** What kind of problem this is. */
  code: ConfigProblemCode;
  /** JSON Pointer to the field at fault. */
  path: string;
  /** Safe to show an administrator. */
  message: string;
}

/** The effective policy at one override's scope. */
export interface ScopedPolicy {
  /** The scope the policy is in force at. */
  scope: NarrowerScope;
  /** The district floor tightened by every override at or above this scope. */
  effective: PolicySettings;
}

/** A document that compiled. */
export interface CompiledConfig {
  /** The normalized desired state, ready to store in a revision. */
  desired: DesiredState;
  /** Every pack in `desired.modules`, dependencies first. */
  installOrder: CapabilityId[];
  /** The effective policy at every override's scope. */
  effectivePolicies: ScopedPolicy[];
}

/** A compiled configuration, or every problem with the document. */
export type CompileResult = { ok: true; compiled: CompiledConfig } | { ok: false; problems: ConfigProblem[] };

function issuePointer(base: string, path: readonly PropertyKey[]): string {
  return base + path.map((segment) => `/${pointerSegment(String(segment))}`).join("");
}

function zodProblems(code: ConfigProblemCode, base: string, error: z.ZodError): ConfigProblem[] {
  return error.issues.map((issue) => ({ code, path: issuePointer(base, issue.path), message: issue.message }));
}

function resolutionProblem(problem: ResolutionProblem): ConfigProblem {
  switch (problem.kind) {
    case "unknown-capability":
      return { code: problem.kind, path: `/modules/${problem.capabilityId}`, message: `no capability pack named ${problem.capabilityId} is available` };
    case "no-version-in-range":
      return {
        code: problem.kind,
        path: `/modules/${problem.capabilityId}/version`,
        message: `no version of ${problem.capabilityId} matches ${problem.versionRange}; available: ${problem.availableVersions.join(", ")}`,
      };
    case "missing-dependency":
      return {
        code: problem.kind,
        path: `/modules/${problem.capabilityId}`,
        message: `${problem.capabilityId} needs ${problem.dependencyId} ${problem.versionRange}, which is not available`,
      };
    case "version-mismatch":
      return {
        code: problem.kind,
        path: `/modules/${problem.capabilityId}`,
        message: `${problem.capabilityId} needs ${problem.dependencyId} ${problem.versionRange}, but ${problem.availableVersion} is available`,
      };
    case "invalid-version-range":
      return {
        code: problem.kind,
        path: `/modules/${problem.capabilityId}`,
        message: `${problem.capabilityId} pins ${problem.dependencyId} with an unsupported range ${problem.versionRange}`,
      };
    case "conflict":
      return {
        code: problem.kind,
        path: `/modules/${problem.capabilityId}`,
        message: `${problem.capabilityId} cannot be installed with ${problem.conflictsWith}`,
      };
    case "dependency-cycle":
      return { code: problem.kind, path: `/modules/${problem.path[0]}`, message: `dependency cycle: ${problem.path.join(" -> ")}` };
  }
}

const isActive = (state: ModuleState) => state !== "disabled";

/**
 * Compiles a district configuration document against a capability registry. It refuses credentials
 * anywhere in the document, validates every module's configuration against its pack schema, pulls
 * in dependencies, checks that no disabled pack is needed by an enabled one, builds the district
 * policy floor from the profile and the document, and resolves every override against it. All
 * problems are reported together.
 */
export function compileDistrictConfig(input: unknown, registry: CapabilityRegistry): CompileResult {
  const problems: ConfigProblem[] = findSecrets(input).map((finding) => ({
    code: "secret-in-config",
    path: finding.path,
    message: finding.kind === "key"
      ? "credential fields are not allowed in configuration; bind the credential as a Worker secret"
      : "this value looks like a credential; bind it as a Worker secret instead",
  }));

  const parsed = DistrictConfigDocument.safeParse(input);
  if (!parsed.success) return { ok: false, problems: [...problems, ...zodProblems("invalid-document", "", parsed.error)] };
  const document = parsed.data;

  const entries = Object.entries(document.modules) as [CapabilityId, ModuleEntry][];
  const ranges = new Map(entries.flatMap(([id, entry]) =>
    typeof entry !== "string" && entry.version !== undefined ? [[id, entry.version] as const] : []
  ));
  const resolution = resolveDependencies(registry, entries.map(([id]) => id), ranges);
  problems.push(...resolution.problems.map(resolutionProblem));

  // Each listed pack is validated against the version selected for it.
  const listed = new Map<CapabilityId, { state: ModuleState; config: Record<string, unknown> }>();
  for (const [id, entry] of entries) {
    const state = typeof entry === "string" ? entry : entry.state;
    const pack = resolution.selected.get(id);
    if (pack === undefined) continue; // Reported by dependency resolution.
    if (state === "advisory" && !pack.supportsAdvisory) {
      problems.push({ code: "advisory-unsupported", path: `/modules/${id}`, message: `${id} cannot run in advisory mode` });
    }
    const config = pack.config.safeParse(typeof entry === "string" ? {} : entry.config ?? {});
    if (config.success) listed.set(id, { state, config: config.data });
    else problems.push(...zodProblems("invalid-pack-config", `/modules/${id}/config`, config.error));
  }

  // A pack must be on wherever something on depends on it, and installed wherever anything does.
  const needsActive = new Set<CapabilityId>();
  const queue = [...listed].filter(([, module]) => isActive(module.state)).map(([id]) => id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const { id: dependencyId } of resolution.selected.get(id)?.manifest.dependencies ?? []) {
      if (needsActive.has(dependencyId) || !resolution.selected.has(dependencyId)) continue;
      needsActive.add(dependencyId);
      queue.push(dependencyId);
    }
  }

  const modules: Record<string, DesiredModule> = {};
  for (const id of resolution.closure) {
    const pack = resolution.selected.get(id)!;
    const listedModule = listed.get(id);
    if (listedModule !== undefined) {
      if (!isActive(listedModule.state) && needsActive.has(id)) {
        const dependents = (resolution.dependents.get(id) ?? [])
          .filter((d) => isActive(listed.get(d)?.state ?? (needsActive.has(d) ? "enabled" : "disabled")));
        problems.push({
          code: "dependency-disabled",
          path: `/modules/${id}`,
          message: `${id} is disabled but ${dependents.join(", ")} depend${dependents.length === 1 ? "s" : ""} on it`,
        });
      }
      modules[id] = { state: listedModule.state, version: pack.manifest.version, config: listedModule.config };
    } else if (!Object.hasOwn(document.modules, id)) {
      modules[id] = {
        state: needsActive.has(id) ? "enabled" : "disabled",
        version: pack.manifest.version,
        config: pack.config.parse({}),
        requiredBy: [...(resolution.dependents.get(id) ?? [])],
      };
    }
  }

  if (document.curriculum !== undefined && !isActive(modules["learning-registry"]?.state ?? "disabled")) {
    problems.push({
      code: "curriculum-needs-learning-registry",
      path: "/curriculum",
      message: "curriculum frameworks are served by learning-registry, which is not enabled",
    });
  }

  const floor = PolicySettings.parse({ ...DEFAULTS_PROFILES[document.profile], ...toPolicyOverrides(document.policies) });
  const { overrides, effectivePolicies } = resolveOverrides(document, floor, problems);

  if (problems.length > 0) return { ok: false, problems };
  const desired: DesiredState = {
    apiVersion: document.apiVersion,
    district: document.district,
    profile: document.profile,
    identity: document.identity,
    rostering: document.rostering,
    ...(document.curriculum === undefined ? {} : {
      curriculum: {
        frameworks: sortedUnique(document.curriculum.frameworks),
        importedSources: sortedUnique(document.curriculum.importedSources),
      },
    }),
    modules,
    rollout: {
      target: document.rollout.target,
      offerings: sortedUnique(document.rollout.offerings ?? []),
      requiresAdminActivation: document.rollout.requiresAdminActivation,
    },
    policies: floor,
    overrides,
  };
  return { ok: true, compiled: { desired, installOrder: resolution.installOrder, effectivePolicies } };
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Validates the overrides and resolves the effective policy at each one's scope: the district floor,
 * then every override whose scope contains it, narrowest last. A loosening is reported once, at the
 * override that attempted it, however many narrower scopes inherit the attempt.
 */
function resolveOverrides(
  document: DistrictConfigDocument,
  floor: PolicySettings,
  problems: ConfigProblem[],
): { overrides: DesiredState["overrides"]; effectivePolicies: ScopedPolicy[] } {
  const seen = new Set<string>();
  const valid: { index: number; scope: NarrowerScope; settings: PolicyOverrides }[] = [];
  document.overrides.forEach((override, index) => {
    const key = canonicalJson(override.scope);
    if (override.scope.districtId !== document.district) {
      problems.push({ code: "scope-outside-district", path: `/overrides/${index}/scope`, message: "an override must name a scope in this district" });
    } else if (seen.has(key)) {
      problems.push({ code: "duplicate-override", path: `/overrides/${index}/scope`, message: "another override already names this scope" });
    } else {
      seen.add(key);
      valid.push({ index, scope: override.scope, settings: toPolicyOverrides(override.policies) });
    }
  });

  const reported = new Set<string>();
  const effectivePolicies: ScopedPolicy[] = [];
  for (const target of valid) {
    const containing = valid.filter((candidate) => scopeContains(candidate.scope, target.scope));
    const layers: PolicyLayer[] = containing.map((c) => ({ level: c.scope.level as PolicyLayer["level"], settings: c.settings }));
    const resolution = resolvePolicy(floor, layers);
    if (resolution.ok) {
      effectivePolicies.push({ scope: target.scope, effective: resolution.effective });
      continue;
    }
    for (const violation of resolution.violations) {
      // Within one containment chain each level appears at most once, so the level names the override.
      const source = containing.find((c) => c.scope.level === violation.level)!;
      const key = `${source.index} ${violation.key}`;
      if (reported.has(key)) continue;
      reported.add(key);
      problems.push({
        code: "policy-violation",
        path: `/overrides/${source.index}/policies`,
        message: `a ${violation.level} override cannot loosen ${violation.key} from ${String(violation.floor)} to ${String(violation.requested)}`,
      });
    }
  }
  return {
    overrides: valid
      .map(({ scope, settings }) => ({ scope, settings }))
      .toSorted((a, b) => (canonicalJson(a.scope) < canonicalJson(b.scope) ? -1 : 1)),
    effectivePolicies,
  };
}
