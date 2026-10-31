// Observes the account and diffs it against the desired state. Observation is the only state the
// reconciler has: there is no local state file, so a run interrupted at any point is resumed by
// running again, and a second machine (the district's own CI after the root's OAuth grant is
// revoked) reconciles exactly as the first would.
import { EducateOsError } from "@educateos/contracts";
import type { AccessRule, CloudflareApi, KvNamespace, ObservedBinding } from "./cloudflare-api.ts";
import { stableStringify } from "./digest.ts";
import type { SecretSource } from "./config.ts";
import {
  type DesiredResource,
  type DesiredState,
  type DesiredWorker,
  MARKER_VARS,
  RESOURCE_KEYS,
  type ResourceKey,
} from "./desired.ts";
import { InstallerHaltedError, isCredentialFailure } from "./errors.ts";
import { type ManagedHostnameOp, planManagedHostname } from "./managed-hostname.ts";
import { migrationsFrom, type ResourceOutputs, resolveBindings, workerDigest } from "./render.ts";

/** What observation found for one desired resource. */
export type Observation =
  | { status: "absent" }
  | { status: "owned"; detail?: string }
  | { status: "foreign"; reason: string };

/** What the reconciler will do with one resource. */
export type PlanAction = "create" | "update" | "delete" | "noop" | "refuse" | "needs-input";

/** One step of a plan. */
export interface PlanStep {
  key: ResourceKey;
  kind: DesiredResource["kind"];
  action: PlanAction;
  /** Why, in operator terms. Never contains a secret value. */
  reason: string;
  resource: DesiredResource;
  /** Workers only: the Durable Object migration tag observed before the step. */
  observedMigrationTag?: string;
  /** D1 only: migration IDs not yet applied. */
  pendingMigrations?: string[];
  /** The managed hostname only: the operations applying runs, in order. */
  managedOps?: ManagedHostnameOp[];
  /**
   * An adopted Worker only: secrets to delete before the upload, because the release sets a
   * plain-text var of the same name (a ForgeGraph-deployed district keeps CF_ACCESS_AUD as a secret).
   */
  deleteSecrets?: string[];
}

/** Billable products the plan touches, for the operator's cost review. */
export interface CostLine {
  product: string;
  /** How Cloudflare bills it. */
  billedBy: string;
  /** Resources of this product the instance will have. */
  total: number;
  /** How many this plan creates. */
  creating: number;
}

/** The plan for one reconcile: ordered steps, what blocks it, and its cost-relevant summary. */
export interface InstallPlan {
  desired: DesiredState;
  steps: PlanStep[];
  /** Steps that stop the plan from being applied: resources the installer does not own, or missing secrets. */
  blocked: PlanStep[];
  /** Outputs already known from observation. */
  outputs: ResourceOutputs;
  /** The zone ID of the base domain, if the install has one and the zone exists. */
  zoneId?: string;
  cost: CostLine[];
}

/**
 * Calls the port, turning a credential failure into {@link InstallerHaltedError} so callers stop
 * at once instead of trying the next operation.
 */
export async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isCredentialFailure(error)) throw new InstallerHaltedError(error);
    throw error;
  }
}

/** Observes the account and plans the changes that bring it to the desired state. Read-only. */
export async function planInstall(api: CloudflareApi, desired: DesiredState, secrets: SecretSource): Promise<InstallPlan> {
  const account = desired.accountId;
  const kinds = new Set(desired.resources.map((r) => r.kind));
  const zoneName = zoneNameOf(desired);
  const list = <T>(needed: boolean, call: () => Promise<T[]>) => (needed ? guarded(call) : Promise.resolve([] as T[]));

  const [scripts, kv, r2, d1, policies, apps, gateways, domains, zone] = await Promise.all([
    guarded(() => api.listWorkerScripts(account)),
    list<KvNamespace>(kinds.has("kv_namespace"), () => api.listKvNamespaces(account)),
    list(kinds.has("r2_bucket"), () => api.listR2Buckets(account)),
    list(kinds.has("d1_database"), () => api.listD1Databases(account)),
    guarded(() => api.listAccessPolicies(account)),
    guarded(() => api.listAccessApplications(account)),
    list(kinds.has("ai_gateway"), () => api.listAiGateways(account)),
    guarded(() => api.listWorkerDomains(account)),
    zoneName === undefined ? Promise.resolve(undefined) : guarded(() => api.findZone(account, zoneName)),
  ]);

  const instanceScripts = new Set(desired.resources.flatMap((r) => (r.kind === "worker_script" && r.role !== "router" ? [r.scriptName] : [])));
  const outputs: ResourceOutputs = new Map();
  const steps: PlanStep[] = [];
  const workerOwned = new Map<ResourceKey, boolean>();

  for (const resource of desired.resources) {
    const step = (action: PlanAction, reason: string, extra: Partial<PlanStep> = {}): PlanStep => {
      const planned = { key: resource.key, kind: resource.kind, action, reason, resource, ...extra };
      steps.push(planned);
      return planned;
    };
    switch (resource.kind) {
      case "kv_namespace": {
        const found = kv.find((ns) => ns.title === resource.title);
        if (found) outputs.set(resource.key, { id: found.id });
        step(found ? "noop" : "create", found ? "namespace exists" : "namespace missing");
        break;
      }
      case "r2_bucket": {
        const found = r2.some((b) => b.name === resource.name);
        step(found ? "noop" : "create", found ? "bucket exists" : "bucket missing");
        break;
      }
      case "d1_database": {
        const found = d1.find((db) => db.name === resource.name);
        if (!found) {
          step("create", "database missing", { pendingMigrations: resource.migrations.map((m) => m.id) });
          break;
        }
        outputs.set(resource.key, { id: found.uuid });
        const applied = await appliedD1Migrations(api, account, found.uuid);
        const pending = resource.migrations.filter((m) => !applied.has(m.id)).map((m) => m.id);
        step(pending.length > 0 ? "update" : "noop", pending.length > 0 ? `${pending.length} migration(s) to apply` : "migrations applied", {
          pendingMigrations: pending,
        });
        break;
      }
      case "ai_gateway": {
        const found = gateways.some((g) => g.id === resource.gatewayId);
        step(found ? "noop" : "create", found ? "gateway exists" : "gateway missing");
        break;
      }
      case "access_policy": {
        const found = policies.find((p) => p.name === resource.spec.name);
        if (!found) {
          step("create", "policy missing");
          break;
        }
        outputs.set(resource.key, { id: found.id });
        const same = found.decision === resource.spec.decision && sameRules(found.include, resource.spec.include);
        step(same ? "noop" : "update", same ? "policy matches" : resource.spec.decision === "allow" ? "admitted email domains differ" : "policy differs");
        break;
      }
      case "access_application": {
        const ours = apps.find((a) => a.name === resource.name);
        const onDomain = apps.find((a) => a.name !== resource.name && a.destinations.some((d) => resource.destinations.includes(d)));
        if (onDomain) {
          const shared = onDomain.destinations.filter((d) => resource.destinations.includes(d)).join(", ");
          step("refuse", `Access application "${onDomain.name}" already protects ${shared} and is not this instance's`);
          break;
        }
        if (!ours) {
          step("create", "application missing");
          break;
        }
        outputs.set(resource.key, { id: ours.id, aud: ours.aud });
        const policyId = outputs.get(resource.policyKey)?.id;
        const same = ours.domain === resource.domain && ours.destinations.toSorted().join() === resource.destinations.toSorted().join() &&
          policyId !== undefined && ours.policyIds.length === 1 && ours.policyIds[0] === policyId;
        step(same ? "noop" : "update", same ? "application matches" : "hostnames or policy differ");
        break;
      }
      case "worker_script": {
        const found = scripts.find((s) => s.name === resource.scriptName);
        if (!found) {
          workerOwned.set(resource.key, false);
          step("create", "Worker missing");
          break;
        }
        const settings = await guarded(() => api.getWorkerSettings(account, resource.scriptName));
        const marker = settings.bindings.find((b) => b.type === "plain_text" && b.name === MARKER_VARS.instance)?.text;
        if (marker === undefined && resource.adoptable) {
          const refusal = adoptionRefusal(resource, found.migrationTag);
          if (refusal) {
            step("refuse", refusal);
            break;
          }
          workerOwned.set(resource.key, true);
          steps.push(await planAdoption(resource, found.migrationTag, settings.bindings));
          break;
        }
        if (marker !== desired.instanceId) {
          step("refuse", marker
            ? `Worker ${resource.scriptName} belongs to instance ${marker}`
            : `Worker ${resource.scriptName} exists but was not created by the EducateOS installer`);
          break;
        }
        workerOwned.set(resource.key, true);
        steps.push(await planWorker(resource, found.migrationTag, settings.bindings, outputs));
        break;
      }
      case "worker_secret": {
        const hasValue = secrets.get(resource.pkgName, resource.secretName) !== undefined;
        const existing = workerOwned.get(workerKeyOf(resource))
          ? await guarded(() => api.listWorkerSecrets(account, resource.scriptName))
          : [];
        if (existing.includes(resource.secretName)) step("noop", "secret set (values are never read back)");
        else if (hasValue) step("create", "secret not set");
        else if (resource.generated) step("create", "secret not set; the installer generates it");
        else step("needs-input", `supply ${resource.secretName} for ${resource.pkgName}`);
        break;
      }
      case "worker_schedules": {
        if (!workerOwned.get(workerKeyOf(resource))) {
          step("create", `sets Cron Triggers ${resource.crons.join(", ")}`);
          break;
        }
        const observed = await guarded(() => api.getWorkerSchedules(account, resource.scriptName));
        const changes = scheduleChanges(resource.crons, observed);
        step(changes.length > 0 ? "update" : "noop", changes.length > 0 ? `Cron Triggers differ: ${changes.join("; ")}` : "Cron Triggers match");
        break;
      }
      case "worker_retired": {
        const found = scripts.find((s) => s.name === resource.scriptName);
        if (!found) {
          step("noop", "service not installed");
          break;
        }
        const settings = await guarded(() => api.getWorkerSettings(account, resource.scriptName));
        const marker = settings.bindings.find((b) => b.type === "plain_text" && b.name === MARKER_VARS.instance)?.text;
        if (marker !== desired.instanceId) {
          // Never delete what the installer does not own; a foreign Worker of that name is left alone.
          step("noop", `Worker ${resource.scriptName} is not this instance's; left in place`);
          break;
        }
        step("delete", "service disabled: deletes the Worker and its Durable Object data, after the backend drops its binding");
        break;
      }
      case "custom_domain": {
        const found = domains.find((d) => d.hostname === resource.hostname);
        if (found && found.service !== resource.scriptName) {
          step("refuse", `${resource.hostname} already routes to Worker ${found.service}`);
        } else if (!zone) {
          step("needs-input", `add the zone ${resource.zoneName} to the account`);
        } else {
          step(found ? "noop" : "create", found ? "domain attached" : "domain not attached");
        }
        break;
      }
      case "managed_hostname": {
        const managed = await planManagedHostname(api, resource, { accountId: account, instanceId: desired.instanceId, domains, zone, instanceScripts });
        step(managed.action, managed.reason, { managedOps: managed.ops });
        break;
      }
    }
  }

  const blocked = steps.filter((s) => s.action === "refuse" || s.action === "needs-input");
  return { desired, steps, blocked, outputs, ...(zone ? { zoneId: zone.id } : {}), cost: costSummary(desired, steps) };
}

async function planWorker(
  worker: DesiredWorker,
  migrationTag: string | undefined,
  observed: ObservedBinding[],
  outputs: ResourceOutputs,
): Promise<PlanStep> {
  const base = { key: worker.key, kind: worker.kind, resource: worker, ...(migrationTag ? { observedMigrationTag: migrationTag } : {}) };
  try {
    migrationsFrom(worker, migrationTag);
  } catch (error) {
    if (error instanceof EducateOsError) return { ...base, action: "refuse", reason: error.message };
    throw error;
  }
  const serviceChanges = serviceBindingChanges(worker, observed);
  const suffix = serviceChanges.length > 0 ? `; ${serviceChanges.join("; ")}` : "";
  const bindings = resolveBindings(worker, outputs);
  if (!bindings) return { ...base, action: "update", reason: `a dependency will be created first${suffix}` };
  const digest = await workerDigest(worker, bindings);
  const current = observed.find((b) => b.type === "plain_text" && b.name === MARKER_VARS.digest)?.text;
  if (current !== digest) return { ...base, action: "update", reason: `release content or configuration changed${suffix}` };
  // The digest marker survives a dashboard edit, so service bindings are also compared directly:
  // a removed or retargeted binding (such as AI_CALL_GUARD) is drift the next apply repairs.
  return serviceChanges.length > 0
    ? { ...base, action: "update", reason: `drift: ${serviceChanges.join("; ")}` }
    : { ...base, action: "noop", reason: "deployed version matches the release" };
}

/**
 * Why a Worker deployed outside the installer can't be adopted, or undefined if it can. Its Durable
 * Objects hold the district's data, so the upload must continue them: the Worker's migration tag
 * must be in the release's history. A release with migrations needs a tag, since a Worker without
 * one has no objects to keep and is not this package's deployment.
 */
function adoptionRefusal(worker: DesiredWorker, migrationTag: string | undefined): string | undefined {
  const tags = worker.migrations.map((m) => m.tag);
  if (tags.length > 0 && migrationTag === undefined) {
    return `Worker ${worker.scriptName} has no Durable Object migration tag, so it holds none of ${worker.pkgName}'s objects: not adopted`;
  }
  if (migrationTag !== undefined && !tags.includes(migrationTag)) {
    return `Worker ${worker.scriptName} is at Durable Object migration tag ${migrationTag}, which this release's ${worker.pkgName} does not know: not adopted`;
  }
  return undefined;
}

/**
 * The plan for adopting a Worker deployed outside the installer: one upload of the release over it,
 * which adds the installer's markers, continues its Durable Object migrations, and keeps its secrets,
 * except any the release now sets as plain-text vars, which are deleted first.
 */
async function planAdoption(worker: DesiredWorker, migrationTag: string | undefined, observed: ObservedBinding[]): Promise<PlanStep> {
  const plain = new Set(worker.bindings.filter((b) => b.type === "plain_text" || b.type === "json").map((b) => b.name));
  const deleteSecrets = observed.filter((b) => b.type === "secret_text" && plain.has(b.name)).map((b) => b.name).toSorted();
  const kept = migrationTag ? `keeps its Durable Objects at migration tag ${migrationTag}` : "has no Durable Objects";
  const deleting = deleteSecrets.length > 0 ? `; deletes secret(s) ${deleteSecrets.join(", ")}, which the release sets as vars` : "";
  const serviceChanges = serviceBindingChanges(worker, observed);
  return {
    key: worker.key,
    kind: worker.kind,
    resource: worker,
    action: "update",
    reason: `adopts Worker ${worker.scriptName}, deployed outside the installer: ${kept}${deleting}` +
      (serviceChanges.length > 0 ? `; ${serviceChanges.join("; ")}` : ""),
    ...(migrationTag ? { observedMigrationTag: migrationTag } : {}),
    ...(deleteSecrets.length > 0 ? { deleteSecrets } : {}),
  };
}

/**
 * How a Worker's deployed service bindings differ from the desired ones, in operator terms, e.g.
 * `binds AI_CALL_GUARD to educateos-x-educateos-ai-guard (EducateOsAiCallGuard)`. Service binding
 * targets are literal Worker names, so this needs no outputs.
 */
export function serviceBindingChanges(worker: DesiredWorker, observed: ObservedBinding[]): string[] {
  const want = new Map(worker.bindings.filter((b) => b.type === "service").map((b) => [b.name, describeServiceTarget(b)]));
  const have = new Map(observed.filter((b) => b.type === "service").map((b) => [b.name, describeServiceTarget(b)]));
  const changes: string[] = [];
  for (const [name, target] of want) {
    const current = have.get(name);
    if (current === undefined) changes.push(`binds ${name} to ${target}`);
    else if (current !== target) changes.push(`rebinds ${name} from ${current} to ${target}`);
  }
  for (const name of have.keys()) if (!want.has(name)) changes.push(`removes binding ${name}`);
  return changes;
}

function describeServiceTarget(binding: Record<string, unknown>): string {
  return `${String(binding.service)}${typeof binding.entrypoint === "string" ? ` (${binding.entrypoint})` : ""}`;
}

/**
 * How a Worker's observed Cron Triggers differ from the desired ones, e.g. `adds 0 14 * * SUN`.
 * Order doesn't matter, and expressions compare as written: an equivalent expression spelled
 * differently (`0 14 * * 0` for Sundays) reads as a change, which an apply turns into the release's.
 */
export function scheduleChanges(desired: readonly string[], observed: readonly string[]): string[] {
  const want = new Set(desired);
  const have = new Set(observed);
  return [
    ...[...want].filter((cron) => !have.has(cron)).map((cron) => `adds ${cron}`),
    ...[...have].filter((cron) => !want.has(cron)).map((cron) => `removes ${cron}`),
  ];
}

/** The D1 migration ledger table. Holds migration IDs only, never district data. */
export const D1_LEDGER_TABLE = "_educateos_migrations";

async function appliedD1Migrations(api: CloudflareApi, account: string, databaseId: string): Promise<Set<string>> {
  const tables = await guarded(() =>
    api.queryD1(account, databaseId, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [D1_LEDGER_TABLE]));
  if (tables.length === 0) return new Set();
  const rows = await guarded(() => api.queryD1(account, databaseId, `SELECT id FROM ${D1_LEDGER_TABLE}`));
  return new Set(rows.map((row) => String(row.id)));
}

/** The base domain's zone name, or undefined on a managed-only install, which has none. */
function zoneNameOf(desired: DesiredState): string | undefined {
  const domain = desired.resources.find((r) => r.key === RESOURCE_KEYS.customDomain);
  return domain?.kind === "custom_domain" ? domain.zoneName : undefined;
}

function workerKeyOf(secret: { dependsOn: ResourceKey[] }): ResourceKey {
  return secret.dependsOn[0]!;
}

/** A policy's include rules as one order-independent string. */
function rulesKey(rules: readonly AccessRule[]): string {
  return rules.map((rule) => stableStringify(rule)).toSorted().join("\n");
}

/** Whether two policies' include rules are the same set, in any order. */
function sameRules(a: readonly AccessRule[], b: readonly AccessRule[]): boolean {
  return a.length === b.length && rulesKey(a) === rulesKey(b);
}

function costSummary(desired: DesiredState, steps: PlanStep[]): CostLine[] {
  const creating = (kind: DesiredResource["kind"]) => steps.filter((s) => s.kind === kind && s.action === "create").length;
  const count = (kind: DesiredResource["kind"]) => desired.resources.filter((r) => r.kind === kind).length;
  const workers = desired.resources.filter((r): r is DesiredWorker => r.kind === "worker_script");
  const classes = workers.flatMap((w) => w.migrations.flatMap((m) => m.new_sqlite_classes ?? []));
  const usesBinding = (type: string) => workers.filter((w) => w.bindings.some((b) => b.type === type)).length;
  const lines: CostLine[] = [
    { product: "Workers (Workers Paid plan)", billedBy: "requests and CPU time", total: workers.length, creating: creating("worker_script") },
    { product: "Durable Objects (SQLite)", billedBy: "requests, duration and stored data", total: classes.length, creating: 0 },
    { product: "Workers KV", billedBy: "reads, writes and stored data", total: count("kv_namespace"), creating: creating("kv_namespace") },
    { product: "R2", billedBy: "stored data and operations", total: count("r2_bucket"), creating: creating("r2_bucket") },
    { product: "D1", billedBy: "rows read and written, stored data", total: count("d1_database"), creating: creating("d1_database") },
    { product: "Workers AI", billedBy: "neurons", total: usesBinding("ai"), creating: 0 },
    { product: "Browser Rendering", billedBy: "browser time", total: usesBinding("browser"), creating: 0 },
    { product: "AI Gateway", billedBy: "free core features; provider spend is the provider's", total: count("ai_gateway"), creating: creating("ai_gateway") },
    { product: "Zero Trust Access", billedBy: "seats: every student and teacher who signs in", total: count("access_application"), creating: creating("access_application") },
  ];
  // Durable Object classes are created by migrations inside Worker uploads, not counted as creates.
  return lines.filter((line) => line.total > 0);
}
