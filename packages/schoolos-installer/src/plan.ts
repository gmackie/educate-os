// Observes the account and diffs it against the desired state. Observation is the only state the
// reconciler has: there is no local state file, so a run interrupted at any point is resumed by
// running again, and a second machine (the district's own CI after the root's OAuth grant is
// revoked) reconciles exactly as the first would.
import { SchoolOsError } from "@schoolos/contracts";
import type { CloudflareApi, KvNamespace } from "./cloudflare-api.ts";
import type { SecretSource } from "./config.ts";
import {
  type DesiredResource,
  type DesiredState,
  type DesiredWorker,
  MARKER_VARS,
  type ResourceKey,
} from "./desired.ts";
import { InstallerHaltedError, isCredentialFailure } from "./errors.ts";
import { migrationsFrom, type ResourceOutputs, resolveBindings, workerDigest } from "./render.ts";

/** What observation found for one desired resource. */
export type Observation =
  | { status: "absent" }
  | { status: "owned"; detail?: string }
  | { status: "foreign"; reason: string };

/** What the reconciler will do with one resource. */
export type PlanAction = "create" | "update" | "noop" | "refuse" | "needs-input";

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
  /** The zone ID of the base domain, if the zone exists. */
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
    guarded(() => api.findZone(account, zoneNameOf(desired))),
  ]);

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
        const same = found.decision === resource.spec.decision &&
          sameDomains(found.include.map((r) => r.email_domain.domain), resource.spec.include.map((r) => r.email_domain.domain));
        step(same ? "noop" : "update", same ? "policy matches" : "admitted email domains differ");
        break;
      }
      case "access_application": {
        const ours = apps.find((a) => a.name === resource.name);
        const onDomain = apps.find((a) => a.domain === resource.domain && a.name !== resource.name);
        if (onDomain) {
          step("refuse", `Access application "${onDomain.name}" already protects ${resource.domain} and is not this instance's`);
          break;
        }
        if (!ours) {
          step("create", "application missing");
          break;
        }
        outputs.set(resource.key, { id: ours.id, aud: ours.aud });
        const policyId = outputs.get(resource.policyKey)?.id;
        const same = ours.domain === resource.domain && policyId !== undefined && ours.policyIds.length === 1 && ours.policyIds[0] === policyId;
        step(same ? "noop" : "update", same ? "application matches" : "domain or policy differs");
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
        if (marker !== desired.instanceId) {
          step("refuse", marker
            ? `Worker ${resource.scriptName} belongs to instance ${marker}`
            : `Worker ${resource.scriptName} exists but was not created by the SchoolOS installer`);
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
        else step("needs-input", `supply ${resource.secretName} for ${resource.pkgName}`);
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
    }
  }

  const blocked = steps.filter((s) => s.action === "refuse" || s.action === "needs-input");
  return { desired, steps, blocked, outputs, ...(zone ? { zoneId: zone.id } : {}), cost: costSummary(desired, steps) };
}

async function planWorker(
  worker: DesiredWorker,
  migrationTag: string | undefined,
  observed: { type: string; name: string; text?: string }[],
  outputs: ResourceOutputs,
): Promise<PlanStep> {
  const base = { key: worker.key, kind: worker.kind, resource: worker, ...(migrationTag ? { observedMigrationTag: migrationTag } : {}) };
  try {
    migrationsFrom(worker, migrationTag);
  } catch (error) {
    if (error instanceof SchoolOsError) return { ...base, action: "refuse", reason: error.message };
    throw error;
  }
  const bindings = resolveBindings(worker, outputs);
  if (!bindings) return { ...base, action: "update", reason: "a dependency will be created first" };
  const digest = await workerDigest(worker, bindings);
  const current = observed.find((b) => b.type === "plain_text" && b.name === MARKER_VARS.digest)?.text;
  return current === digest
    ? { ...base, action: "noop", reason: "deployed version matches the release" }
    : { ...base, action: "update", reason: "release content or configuration changed" };
}

/** The D1 migration ledger table. Holds migration IDs only, never district data. */
export const D1_LEDGER_TABLE = "_schoolos_migrations";

async function appliedD1Migrations(api: CloudflareApi, account: string, databaseId: string): Promise<Set<string>> {
  const tables = await guarded(() =>
    api.queryD1(account, databaseId, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [D1_LEDGER_TABLE]));
  if (tables.length === 0) return new Set();
  const rows = await guarded(() => api.queryD1(account, databaseId, `SELECT id FROM ${D1_LEDGER_TABLE}`));
  return new Set(rows.map((row) => String(row.id)));
}

function zoneNameOf(desired: DesiredState): string {
  const domain = desired.resources.find((r) => r.kind === "custom_domain");
  if (domain?.kind !== "custom_domain") throw new SchoolOsError("validation-failed", "desired state has no custom domain");
  return domain.zoneName;
}

function workerKeyOf(secret: { dependsOn: ResourceKey[] }): ResourceKey {
  return secret.dependsOn[0]!;
}

function sameDomains(a: string[], b: string[]): boolean {
  return a.length === b.length && a.toSorted().join() === b.toSorted().join();
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
