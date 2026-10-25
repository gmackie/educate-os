// Rollback to the previous release, where Cloudflare can do it: a Worker can be redeployed at a
// version it already has, unless a Durable Object migration has happened since, which Cloudflare
// cannot undo. D1 migrations are never reversed; the previous code then runs against the newer
// schema, and the plan says so. KV, R2 and D1 resources themselves are left alone.
import { EducateOsError } from "@educateos/contracts";
import type { CloudflareApi } from "./cloudflare-api.ts";
import { type DesiredState, type DesiredWorker, MARKER_VARS } from "./desired.ts";
import { guarded } from "./plan.ts";

/** What rollback does to one Worker. */
export interface RollbackStep {
  scriptName: string;
  action: "deploy-version" | "already-current" | "blocked";
  /** The version to deploy, for `deploy-version`. */
  versionId?: string;
  reason: string;
}

/** A rollback plan. It can be applied only when {@link RollbackPlan.blocked} is empty. */
export interface RollbackPlan {
  fromReleaseId: string;
  toReleaseId: string;
  /** In the order they will run: dependents before what they depend on. */
  steps: RollbackStep[];
  blocked: RollbackStep[];
  /** Changes rollback leaves in place, such as applied D1 migrations. */
  irreversible: string[];
}

/** Plans a rollback from the current release's desired state to the previous one's. Read-only. */
export async function planRollback(api: CloudflareApi, current: DesiredState, previous: DesiredState): Promise<RollbackPlan> {
  if (current.instanceId !== previous.instanceId || current.accountId !== previous.accountId) {
    throw new EducateOsError("validation-failed", "rollback must stay within one instance");
  }
  const account = current.accountId;
  const scripts = await guarded(() => api.listWorkerScripts(account));
  const deployed = new Set(scripts.map((s) => s.name));
  const previousWorkers = new Map(
    previous.resources.filter((r): r is DesiredWorker => r.kind === "worker_script").map((w) => [w.pkgName, w]),
  );
  const currentWorkers = current.resources.filter((r): r is DesiredWorker => r.kind === "worker_script").toReversed();

  const steps: RollbackStep[] = [];
  const irreversible: string[] = [];
  for (const worker of currentWorkers) {
    const step = (action: RollbackStep["action"], reason: string, versionId?: string) =>
      steps.push({ scriptName: worker.scriptName, action, reason, ...(versionId ? { versionId } : {}) });
    const before = previousWorkers.get(worker.pkgName);
    const script = scripts.find((s) => s.name === worker.scriptName);
    if (!script) {
      step("blocked", "Worker is not deployed");
      continue;
    }
    const settings = await guarded(() => api.getWorkerSettings(account, worker.scriptName));
    const marker = (name: string) => settings.bindings.find((b) => b.type === "plain_text" && b.name === name)?.text;
    if (marker(MARKER_VARS.instance) !== current.instanceId) {
      step("blocked", "Worker is not this instance's");
      continue;
    }
    if (!before) {
      irreversible.push(`${worker.scriptName} is new in ${current.releaseId}; rollback leaves it running`);
      continue;
    }
    if (marker(MARKER_VARS.release) === previous.releaseId) {
      step("already-current", `already on ${previous.releaseId}`);
      continue;
    }
    const previousTag = before.migrations.at(-1)?.tag;
    if (script.migrationTag !== previousTag) {
      step("blocked", `Durable Object migrations after ${previousTag ?? "none"} (now ${script.migrationTag}) are not reversible`);
      continue;
    }
    const versions = await guarded(() => api.listWorkerVersions(account, worker.scriptName));
    const target = versions
      .filter((v) => v.vars[MARKER_VARS.release] === previous.releaseId)
      .toSorted((a, b) => b.createdOn.localeCompare(a.createdOn))[0];
    if (!target) {
      step("blocked", `no retained version of ${previous.releaseId}; reinstall that release instead`);
      continue;
    }
    // A version whose service binding targets a Worker that has since been deleted (a service
    // disabled after that release) cannot be deployed; Cloudflare would refuse it.
    const dangling = target.serviceBindings.filter((b) => !deployed.has(b.service));
    if (dangling.length > 0) {
      step("blocked", `the ${previous.releaseId} version binds ${dangling.map((b) => `${b.name} to ${b.service}`).join(", ")}, which is no longer deployed`);
      continue;
    }
    const currentBindings = new Set(worker.bindings.filter((b) => b.type === "service").map((b) => b.name));
    for (const removed of currentBindings.difference(new Set(target.serviceBindings.map((b) => b.name)))) {
      irreversible.push(`${worker.scriptName} returns to a version without its ${removed} binding; the Worker it bound stays deployed`);
    }
    step("deploy-version", `redeploy version from ${previous.releaseId}`, target.id);
  }

  const previousD1 = new Map(previous.resources.flatMap((r) => (r.kind === "d1_database" ? [[r.key, new Set(r.migrations.map((m) => m.id))]] : [])));
  for (const resource of current.resources) {
    if (resource.kind !== "d1_database") continue;
    const kept = previousD1.get(resource.key) ?? new Set<string>();
    for (const migration of resource.migrations) {
      if (!kept.has(migration.id)) {
        irreversible.push(`D1 migration ${migration.id} on ${resource.name} is not reversible; ${previous.releaseId} code will run against the migrated schema`);
      }
    }
  }

  return {
    fromReleaseId: current.releaseId,
    toReleaseId: previous.releaseId,
    steps,
    blocked: steps.filter((s) => s.action === "blocked"),
    irreversible,
  };
}

/** Applies a rollback plan. Refuses a plan with blocked steps, so a release is never half rolled back. */
export async function applyRollback(api: CloudflareApi, accountId: string, plan: RollbackPlan): Promise<string[]> {
  if (plan.blocked.length > 0) {
    throw new EducateOsError("conflict", `rollback is blocked: ${plan.blocked.map((s) => `${s.scriptName} (${s.reason})`).join("; ")}`);
  }
  const deployed: string[] = [];
  for (const step of plan.steps) {
    if (step.action !== "deploy-version" || !step.versionId) continue;
    const versionId = step.versionId;
    await guarded(() => api.deployWorkerVersion(accountId, step.scriptName, versionId));
    deployed.push(step.scriptName);
  }
  return deployed;
}
