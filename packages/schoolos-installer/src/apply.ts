// Executes a plan in dependency order. Each step is idempotent against observed state: a step
// whose effect landed but whose response was lost is seen as done on the next run's observation,
// because every resource is found by its deterministic, instance-prefixed name (or, for Workers,
// by its digest marker). A credential failure stops the run at that call.
import { SchoolOsError } from "@schoolos/contracts";
import { type ReleaseArtifacts, verifiedAsset, verifiedBlob } from "./artifacts.ts";
import type { CloudflareApi } from "./cloudflare-api.ts";
import type { SecretSource } from "./config.ts";
import type { DesiredD1Database, DesiredWorker } from "./desired.ts";
import { CloudflareApiError } from "./errors.ts";
import { D1_LEDGER_TABLE, guarded, type InstallPlan, type PlanStep } from "./plan.ts";
import { migrationsFrom, type ResourceOutputs, resolveBindings, uploadMetadata, workerDigest } from "./render.ts";

/** What {@link applyPlan} needs. */
export interface ApplyContext {
  api: CloudflareApi;
  artifacts: ReleaseArtifacts;
  secrets: SecretSource;
  /** Called after each completed step, for progress output. Receives no secret values. */
  onStep?: (step: PlanStep) => void;
}

/** What an apply did. */
export interface ApplyResult {
  /** Keys of the steps that changed something, in order. */
  changed: string[];
  outputs: ResourceOutputs;
}

/**
 * Applies a plan. Refuses, before any change, a plan with blocked steps: the installer never
 * modifies a resource it does not own, and never half-installs for want of a secret.
 */
export async function applyPlan(plan: InstallPlan, context: ApplyContext): Promise<ApplyResult> {
  if (plan.blocked.length > 0) {
    throw new SchoolOsError(
      plan.blocked.some((s) => s.action === "refuse") ? "forbidden" : "validation-failed",
      `plan is blocked: ${plan.blocked.map((s) => `${s.key} (${s.reason})`).join("; ")}`,
    );
  }
  const outputs: ResourceOutputs = new Map(plan.outputs);
  const changed: string[] = [];
  const account = plan.desired.accountId;
  const { api } = context;

  for (const step of plan.steps) {
    if (step.action === "noop") continue;
    const resource = step.resource;
    switch (resource.kind) {
      case "kv_namespace": {
        const ns = await guarded(() => api.createKvNamespace(account, resource.title));
        outputs.set(resource.key, { id: ns.id });
        break;
      }
      case "r2_bucket":
        await guarded(() => api.createR2Bucket(account, resource.name));
        break;
      case "d1_database": {
        let id = outputs.get(resource.key)?.id;
        if (!id) {
          const db = await guarded(() => api.createD1Database(account, resource.name));
          id = db.uuid;
          outputs.set(resource.key, { id });
        }
        await applyD1Migrations(context, account, id, resource, step.pendingMigrations ?? []);
        break;
      }
      case "ai_gateway":
        await guarded(() => api.createAiGateway(account, resource.gatewayId));
        break;
      case "access_policy": {
        const existing = outputs.get(resource.key)?.id;
        const policy = existing
          ? await guarded(() => api.updateAccessPolicy(account, existing, resource.spec))
          : await guarded(() => api.createAccessPolicy(account, resource.spec));
        outputs.set(resource.key, { id: policy.id });
        break;
      }
      case "access_application": {
        const policyId = outputs.get(resource.policyKey)?.id;
        if (!policyId) throw new SchoolOsError("unavailable", "Access policy has no ID");
        const spec = { name: resource.name, domain: resource.domain, type: "self_hosted" as const, sessionDuration: resource.sessionDuration, policyIds: [policyId] };
        const existing = outputs.get(resource.key)?.id;
        const app = existing
          ? await guarded(() => api.updateAccessApplication(account, existing, spec))
          : await guarded(() => api.createAccessApplication(account, spec));
        outputs.set(resource.key, { id: app.id, aud: app.aud });
        break;
      }
      case "worker_script":
        await uploadWorker(context, account, resource, step.observedMigrationTag, outputs);
        break;
      case "worker_secret": {
        const value = context.secrets.get(resource.pkgName, resource.secretName);
        if (value === undefined) throw new SchoolOsError("validation-failed", `${resource.secretName} for ${resource.pkgName} is not supplied`);
        await guarded(() => api.putWorkerSecret(account, resource.scriptName, resource.secretName, value));
        break;
      }
      case "worker_retired":
        try {
          await guarded(() => api.deleteWorkerScript(account, resource.scriptName));
        } catch (error) {
          // A delete whose response was lost landed; the Worker is gone either way.
          if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
        }
        break;
      case "custom_domain": {
        const zoneId = plan.zoneId;
        if (!zoneId) throw new SchoolOsError("validation-failed", `zone ${resource.zoneName} is not in the account`);
        await guarded(() => api.attachWorkerDomain(account, { hostname: resource.hostname, service: resource.scriptName, zoneId }));
        break;
      }
    }
    changed.push(step.key);
    context.onStep?.(step);
  }
  return { changed, outputs };
}

async function uploadWorker(
  context: ApplyContext,
  account: string,
  worker: DesiredWorker,
  migrationTag: string | undefined,
  outputs: ResourceOutputs,
): Promise<void> {
  const bindings = resolveBindings(worker, outputs);
  if (!bindings) throw new SchoolOsError("unavailable", `${worker.scriptName}: a dependency's output is missing`);
  const digest = await workerDigest(worker, bindings);
  const modules = await Promise.all(worker.modules.map(async (m) => ({
    name: m.name,
    type: m.type,
    bytes: await verifiedBlob(context.artifacts, m.sha256, m.size),
  })));

  let assetsJwt: string | undefined;
  if (worker.assets) {
    const manifest = worker.assets.manifest;
    const session = await guarded(() => context.api.createAssetsUploadSession(account, worker.scriptName, manifest));
    assetsJwt = session.jwt;
    const sizeOf = new Map(Object.values(manifest).map((entry) => [entry.hash, entry.size]));
    for (const bucket of session.buckets) {
      const files = new Map<string, Uint8Array<ArrayBuffer>>();
      for (const hash of bucket) {
        const size = sizeOf.get(hash);
        if (size === undefined) throw new SchoolOsError("validation-failed", `Cloudflare asked for unknown asset ${hash}`);
        files.set(hash, await verifiedAsset(context.artifacts, hash, size));
      }
      const completion = await guarded(() => context.api.uploadAssets(account, session.jwt, files));
      if (completion) assetsJwt = completion;
    }
  }

  const metadata = uploadMetadata(worker, bindings, digest, migrationsFrom(worker, migrationTag), assetsJwt);
  await guarded(() => context.api.uploadWorkerScript(account, worker.scriptName, { metadata, modules }));
}

async function applyD1Migrations(
  context: ApplyContext,
  account: string,
  databaseId: string,
  database: DesiredD1Database,
  pending: string[],
): Promise<void> {
  const todo = database.migrations.filter((m) => pending.includes(m.id));
  if (todo.length === 0) return;
  await guarded(() => context.api.queryD1(account, databaseId,
    `CREATE TABLE IF NOT EXISTS ${D1_LEDGER_TABLE} (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL)`));
  for (const migration of todo) {
    const sql = new TextDecoder().decode(await verifiedBlob(context.artifacts, migration.sha256, migration.size));
    // The migration and its ledger row go in one request, so an interruption cannot leave a
    // migration applied but unrecorded. That D1 runs such a request as one batch is unverified;
    // see docs/schoolos/installer-permissions.md.
    await guarded(() => context.api.queryD1(account, databaseId,
      `${sql.trim().replace(/;$/, "")};\nINSERT INTO ${D1_LEDGER_TABLE} (id, sha256) VALUES (?, ?)`,
      [migration.id, migration.sha256]));
  }
}
