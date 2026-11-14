// Removes a whole instance from the district's account (SCHO-368, district offboarding): the
// install's plan and apply, run backwards. Like install it keeps no state file: planning observes
// the account, so an interrupted uninstall is resumed by running it again, and a resource already
// gone is `gone`, not an error.
//
// What it deletes is decided by the installer's own naming and markers, never by a prefix match:
//
// - Workers carrying this instance's marker var (`EDUCATEOS_INSTANCE_ID`). A Worker named like one
//   of the instance's but without the marker, or with another instance's, is kept.
// - The storage, Access applications and policies, and AI Gateway that the install config and
//   release name (`compileDesiredState`), by their exact names. An Access application is deleted
//   only while it still fronts the instance's hostname.
// - Custom domains and managed hostnames routing to the instance's own Workers.
//
// Anything else named with the instance's prefix is listed as `unclaimed`, for a person to check,
// and never deleted. The district's data goes with its Workers (their Durable Objects), D1
// databases, KV namespaces and R2 buckets, so applying needs the operator to confirm with the
// instance ID, and an R2 bucket that still holds objects is reported rather than emptied: the
// installer has no object operation, by design (installer-permissions.md).
import { EducateOsError } from "@educateos/contracts";
import { type CloudflareApi, DATA_JURISDICTIONS, type DataJurisdiction } from "./cloudflare-api.ts";
import { type DistrictInstallConfig, resourcePrefix } from "./config.ts";
import { compileDesiredState, type DesiredState, MARKER_VARS, RESOURCE_KEYS } from "./desired.ts";
import { CloudflareApiError } from "./errors.ts";
import { OWNERSHIP_TOKEN_SECRET } from "./fleet-registration.ts";
import { applyManagedHostname, isManagedHostname, type ManagedHostnameOp, originHostname, planManagedHostname } from "./managed-hostname.ts";
import { ownerComment } from "./managed-zone.ts";
import type { ReleaseManifest } from "./manifest.ts";
import { guarded } from "./plan.ts";

/**
 * The uninstall's phases, in the order they run. Hostnames go first, so nothing serves while the
 * rest is removed; Access goes after the Workers, so no hostname is ever served without it; storage
 * after the Workers that bind it. A phase with a failure stops the run before the next one.
 */
export const UNINSTALL_PHASES = ["hostnames", "workers", "access", "storage", "dns"] as const;
/** An uninstall phase. */
export type UninstallPhase = (typeof UNINSTALL_PHASES)[number];

/** What one uninstall step removes, with what deleting it needs. */
export type UninstallTarget =
  | { kind: "managed_hostname"; scriptName: string; ops: ManagedHostnameOp[] }
  | { kind: "custom_domain"; hostname: string; domainId?: string }
  | {
    kind: "worker_script";
    scriptName: string;
    /** The instance's Workers that bind this one, which must be deleted first. */
    boundBy?: string[];
  }
  | { kind: "access_application"; name: string; appId?: string }
  | { kind: "access_policy"; name: string; policyId?: string }
  | { kind: "ai_gateway"; gatewayId: string }
  | { kind: "kv_namespace"; title: string; namespaceId?: string }
  | { kind: "r2_bucket"; name: string; jurisdiction?: DataJurisdiction }
  | { kind: "d1_database"; name: string; databaseId?: string }
  | { kind: "dns_record"; name: string };

/**
 * What the uninstall does with one resource: `delete` it, find it already `gone`, or `keep` it,
 * because it is not provably this instance's or is deliberately left (the reason says which).
 */
export type UninstallAction = "delete" | "gone" | "keep";

/** One step of an uninstall plan. */
export interface UninstallStep {
  /** Stable and unique within a plan, e.g. `worker:educateos-northfield-router`. */
  key: string;
  phase: UninstallPhase;
  action: UninstallAction;
  /** Why, in operator terms. */
  reason: string;
  target: UninstallTarget;
}

/** An uninstall plan: every step, in the order applying runs them. */
export interface UninstallPlan {
  instanceId: string;
  accountId: string;
  /** The instance's public hostname. */
  hostname: string;
  steps: UninstallStep[];
  /**
   * Resources named with the instance's prefix that the plan cannot prove are this instance's (no
   * marker, or not in the install's desired state). Listed for a person to check; never deleted.
   */
  unclaimed: string[];
  /**
   * The backend holds an ownership token from a registry: the install opted in to one (on
   * educateos.io, through the guided install). The registry's record outlives the Workers;
   * deregistering is a separate step (docs/educateos/runbooks/district-offboarding.md).
   */
  registered: boolean;
}

/** One step that failed, and what the operator can do about it. */
export interface UninstallFailure {
  key: string;
  reason: string;
}

/** What applying an uninstall plan did. */
export interface UninstallResult {
  /** Keys of the steps that deleted something (or found it deleted by an earlier, interrupted run). */
  deleted: string[];
  failed: UninstallFailure[];
  /** Keys of the steps not attempted because an earlier phase failed. */
  notAttempted: string[];
}

/** R2's code for deleting a bucket that still holds objects (`BucketNotEmpty`, HTTP 409). */
export const R2_BUCKET_NOT_EMPTY_CODE = 10008;

/**
 * What the operator is told before planning an uninstall. Deleting the instance deletes the
 * district's records; the export is step 1 of the offboarding runbook.
 */
export const DISTRICT_EXPORT_REMINDER =
  "Uninstalling deletes the district's records, which are in its Workers' Durable Objects, D1, KV and R2. " +
  "Export the district first (docs/educateos/runbooks/district-offboarding.md, step 1): a district administrator " +
  "opens the admin console's Export the district card, or downloads GET /api/admin/district/export.zip.";

/** Observes the account and plans the instance's removal. Read-only. */
export async function planUninstall(api: CloudflareApi, desired: DesiredState): Promise<UninstallPlan> {
  const account = desired.accountId;
  const instanceId = desired.instanceId;
  const prefix = resourcePrefix({ instanceId: instanceId as DistrictInstallConfig["instanceId"] });
  const looksOurs = (name: string) => name === prefix || name.startsWith(`${prefix}-`);
  const kinds = new Set(desired.resources.map((r) => r.kind));
  const domainResource = desired.resources.find((r) => r.key === RESOURCE_KEYS.customDomain);
  const zoneName = domainResource?.kind === "custom_domain" ? domainResource.zoneName : undefined;
  const list = <T>(needed: boolean, call: () => Promise<T[]>) => (needed ? guarded(call) : Promise.resolve([] as T[]));

  const [scripts, kv, r2, d1, policies, apps, gateways, domains, zone] = await Promise.all([
    guarded(() => api.listWorkerScripts(account)),
    guarded(() => api.listKvNamespaces(account)),
    list(kinds.has("r2_bucket"), async () => (await Promise.all([undefined, ...DATA_JURISDICTIONS].map(async (jurisdiction) =>
      (await api.listR2Buckets(account, jurisdiction)).map((b) => ({ name: b.name, jurisdiction }))))).flat()),
    guarded(() => api.listD1Databases(account)),
    guarded(() => api.listAccessPolicies(account)),
    guarded(() => api.listAccessApplications(account)),
    guarded(() => api.listAiGateways(account)),
    guarded(() => api.listWorkerDomains(account)),
    zoneName === undefined ? Promise.resolve(undefined) : guarded(() => api.findZone(account, zoneName)),
  ]);

  const steps: UninstallStep[] = [];
  const claimed = new Set<string>();
  const step = (phase: UninstallPhase, action: UninstallAction, key: string, target: UninstallTarget, reason: string) => {
    steps.push({ key, phase, action, reason, target });
  };

  // Workers: the desired and retired names, and anything else with the prefix, each confirmed by
  // its marker. Only marked Workers are deleted.
  const desiredScripts = new Set(desired.resources.flatMap((r) =>
    r.kind === "worker_script" || r.kind === "worker_retired" ? [r.scriptName] : []));
  const existing = new Set(scripts.map((s) => s.name));
  const candidates = [...new Set([...desiredScripts, ...scripts.map((s) => s.name).filter(looksOurs)])].toSorted();
  const owned = new Map<string, Set<string>>();
  for (const name of candidates) {
    if (!existing.has(name)) {
      step("workers", "gone", `worker:${name}`, { kind: "worker_script", scriptName: name }, "Worker not in the account");
      continue;
    }
    const settings = await guarded(() => api.getWorkerSettings(account, name));
    const marker = settings.bindings.find((b) => b.type === "plain_text" && b.name === MARKER_VARS.instance)?.text;
    if (marker === instanceId) {
      owned.set(name, new Set(settings.bindings.flatMap((b) =>
        b.type === "service" && typeof b.service === "string" ? [b.service]
          : b.type === "durable_object_namespace" && typeof b.script_name === "string" ? [b.script_name] : [])));
      claimed.add(`worker:${name}`);
    } else if (desiredScripts.has(name)) {
      step("workers", "keep", `worker:${name}`, { kind: "worker_script", scriptName: name },
        marker ? `belongs to instance ${marker}; left in place` : "was not deployed by the EducateOS installer (no instance marker); left in place");
      claimed.add(`worker:${name}`);
    }
  }
  for (const name of deletionOrder(owned)) {
    const boundBy = [...owned].flatMap(([other, targets]) => (other !== name && targets.has(name) ? [other] : []));
    step("workers", "delete", `worker:${name}`, { kind: "worker_script", scriptName: name, ...(boundBy.length > 0 ? { boundBy } : {}) },
      "deletes the Worker with its Durable Objects (district records among them), secrets and Cron Triggers");
  }

  // Hostnames: the managed hostname's release, then every other domain routed to an owned Worker.
  const router = desired.resources.find((r) => r.kind === "worker_script" && r.role === "router");
  const routerScript = router?.kind === "worker_script" ? router.scriptName : undefined;
  const released = new Set<string>();
  if (routerScript !== undefined && owned.has(routerScript)) {
    const managed = await planManagedHostname(api, {
      kind: "managed_hostname", key: RESOURCE_KEYS.managedHostnameRelease, dependsOn: [], phase: "release",
      hostname: null, scriptName: routerScript, zoneName: zoneName ?? null,
    }, { accountId: account, instanceId, domains, zone, instanceScripts: new Set() });
    if (managed.ops.length > 0) {
      for (const op of managed.ops) if (op.op === "detach-domain") released.add(op.domainId);
      step("hostnames", "delete", "domain:managed", { kind: "managed_hostname", scriptName: routerScript, ops: managed.ops },
        `${managed.reason.replace(/ before the Access application drops it$/, "")}; then ask Gmacko Ventures to release the slug`);
    }
  }
  for (const domain of domains.toSorted((a, b) => a.hostname.localeCompare(b.hostname))) {
    if (!owned.has(domain.service) || released.has(domain.id)) continue;
    step("hostnames", "delete", `domain:${domain.hostname}`, { kind: "custom_domain", hostname: domain.hostname, domainId: domain.id },
      `detaches ${domain.hostname} from Worker ${domain.service}${isManagedHostname(domain.hostname) ? "; then ask Gmacko Ventures to release the slug" : ""}`);
  }
  for (const resource of desired.resources) {
    if (resource.kind !== "custom_domain") continue;
    const found = domains.find((d) => d.hostname === resource.hostname);
    if (!found) step("hostnames", "gone", `domain:${resource.hostname}`, { kind: "custom_domain", hostname: resource.hostname }, "domain not attached");
    else if (!owned.has(found.service)) {
      step("hostnames", "keep", `domain:${resource.hostname}`, { kind: "custom_domain", hostname: resource.hostname },
        `routes to Worker ${found.service}, which is not this instance's; left in place`);
    }
  }

  // Access: applications by name, while they still front this instance's hostname; then the
  // policies by name, once no remaining application uses them.
  const deletedApps = new Set<string>();
  for (const resource of desired.resources) {
    if (resource.kind !== "access_application") continue;
    const found = apps.find((a) => a.name === resource.name);
    const target = { kind: "access_application" as const, name: resource.name, ...(found ? { appId: found.id } : {}) };
    claimed.add(`access-application:${resource.name}`);
    if (!found) step("access", "gone", `access:${resource.name}`, target, "application not in the account");
    else if (found.domain !== resource.domain) {
      step("access", "keep", `access:${resource.name}`, target, `protects ${found.domain}, not ${resource.domain}; left in place`);
    } else {
      deletedApps.add(found.id);
      step("access", "delete", `access:${resource.name}`, target, `deletes the application in front of ${found.destinations.join(", ")}, ending its sessions`);
    }
  }
  for (const resource of desired.resources) {
    if (resource.kind !== "access_policy") continue;
    const name = resource.spec.name;
    const found = policies.find((p) => p.name === name);
    const target = { kind: "access_policy" as const, name, ...(found ? { policyId: found.id } : {}) };
    claimed.add(`access-policy:${name}`);
    const users = found ? apps.filter((a) => a.policyIds.includes(found.id) && !deletedApps.has(a.id)) : [];
    if (!found) step("access", "gone", `access-policy:${name}`, target, "policy not in the account");
    else if (users.length > 0) {
      step("access", "keep", `access-policy:${name}`, target, `still used by Access application ${users.map((a) => `"${a.name}"`).join(", ")}; left in place`);
    } else step("access", "delete", `access-policy:${name}`, target, "deletes the policy");
  }

  // Storage, by the exact names the install gives it.
  for (const resource of desired.resources) {
    switch (resource.kind) {
      case "ai_gateway": {
        claimed.add(`ai-gateway:${resource.gatewayId}`);
        const found = gateways.some((g) => g.id === resource.gatewayId);
        step("storage", found ? "delete" : "gone", `ai-gateway:${resource.gatewayId}`, { kind: "ai_gateway", gatewayId: resource.gatewayId },
          found ? "deletes the gateway and its logs" : "gateway not in the account");
        break;
      }
      case "kv_namespace": {
        claimed.add(`kv:${resource.title}`);
        const found = kv.find((ns) => ns.title === resource.title);
        step("storage", found ? "delete" : "gone", `kv:${resource.title}`, { kind: "kv_namespace", title: resource.title, ...(found ? { namespaceId: found.id } : {}) },
          found ? "deletes the namespace and every value in it" : "namespace not in the account");
        break;
      }
      case "r2_bucket": {
        claimed.add(`r2:${resource.jurisdiction ?? "default"}/${resource.name}`);
        const found = r2.some((b) => b.name === resource.name && b.jurisdiction === resource.jurisdiction);
        step("storage", found ? "delete" : "gone", `r2:${resource.name}`,
          { kind: "r2_bucket", name: resource.name, ...(resource.jurisdiction ? { jurisdiction: resource.jurisdiction } : {}) },
          found
            ? "deletes the bucket once it is empty: the installer never deletes objects, so empty it first (a lifecycle rule that expires every object)"
            : "bucket not in the account");
        break;
      }
      case "d1_database": {
        claimed.add(`d1:${resource.name}`);
        const found = d1.find((db) => db.name === resource.name);
        step("storage", found ? "delete" : "gone", `d1:${resource.name}`, { kind: "d1_database", name: resource.name, ...(found ? { databaseId: found.uuid } : {}) },
          found ? "deletes the database and its data" : "database not in the account");
        break;
      }
    }
  }

  // DNS: the cross-account managed hostname's originless fallback origin. It is the zone's
  // fallback origin, which other custom hostnames on the zone may use, so it is reported, not deleted.
  if (zone && zoneName !== undefined) {
    const origin = originHostname(zoneName);
    const records = await guarded(() => api.listDnsRecords(zone.id, origin));
    if (records.some((r) => r.comment === ownerComment(instanceId))) {
      step("dns", "keep", `dns:${origin}`, { kind: "dns_record", name: origin },
        `the zone's Cloudflare for SaaS fallback origin, which other custom hostnames on ${zoneName} may use; delete it and unset the fallback origin by hand if nothing else uses them`);
    }
  }

  const unclaimed = [
    ...scripts.filter((s) => looksOurs(s.name) && !claimed.has(`worker:${s.name}`)).map((s) => `worker:${s.name}`),
    ...kv.filter((ns) => looksOurs(ns.title) && !claimed.has(`kv:${ns.title}`)).map((ns) => `kv:${ns.title}`),
    ...r2.filter((b) => looksOurs(b.name) && !claimed.has(`r2:${b.jurisdiction ?? "default"}/${b.name}`))
      .map((b) => `r2:${b.name}${b.jurisdiction ? ` (${b.jurisdiction})` : ""}`),
    ...d1.filter((db) => looksOurs(db.name) && !claimed.has(`d1:${db.name}`)).map((db) => `d1:${db.name}`),
    ...apps.filter((a) => looksOurs(a.name) && !claimed.has(`access-application:${a.name}`)).map((a) => `access-application:${a.name}`),
    ...policies.filter((p) => looksOurs(p.name) && !claimed.has(`access-policy:${p.name}`)).map((p) => `access-policy:${p.name}`),
    ...gateways.filter((g) => looksOurs(g.id) && !claimed.has(`ai-gateway:${g.id}`)).map((g) => `ai-gateway:${g.id}`),
  ];

  const backend = desired.resources.find((r) => r.kind === "worker_script" && r.role === "backend");
  const registered = backend?.kind === "worker_script" && owned.has(backend.scriptName) &&
    (await guarded(() => api.listWorkerSecrets(account, backend.scriptName))).includes(OWNERSHIP_TOKEN_SECRET);

  const ordered = UNINSTALL_PHASES.flatMap((phase) => steps.filter((s) => s.phase === phase));
  return { instanceId, accountId: account, hostname: desired.hostname, steps: ordered, unclaimed, registered };
}

/**
 * The order to delete Workers in: each after every Worker that binds it, since Cloudflare refuses to
 * delete a Worker another one binds (code 10142). A cycle, which a release never has, is broken by name.
 */
function deletionOrder(owned: Map<string, Set<string>>): string[] {
  const remaining = new Set([...owned.keys()].toSorted());
  const order: string[] = [];
  while (remaining.size > 0) {
    const free = [...remaining].filter((name) => ![...remaining].some((other) => other !== name && owned.get(other)!.has(name)));
    const next = free.length > 0 ? free : [[...remaining][0]!];
    for (const name of next) {
      remaining.delete(name);
      order.push(name);
    }
  }
  return order;
}

/** What applying an uninstall plan needs besides the plan. */
export interface ApplyUninstallContext {
  api: CloudflareApi;
  /** Called after each step that deleted something. */
  onStep?: (step: UninstallStep) => void;
}

/**
 * Applies an uninstall plan, phase by phase. A step that fails is reported and the phase carries
 * on, but the next phase is not started, so storage is never deleted while a Worker that failed to
 * delete still serves it. A credential failure stops the run at once (InstallerHaltedError). A
 * resource already gone (404) counts as deleted, so a re-run after an interruption continues.
 */
export async function applyUninstall(plan: UninstallPlan, context: ApplyUninstallContext): Promise<UninstallResult> {
  const result: UninstallResult = { deleted: [], failed: [], notAttempted: [] };
  const { api } = context;
  const account = plan.accountId;
  for (const phase of UNINSTALL_PHASES) {
    const todo = plan.steps.filter((s) => s.phase === phase && s.action === "delete");
    if (result.failed.length > 0) {
      result.notAttempted.push(...todo.map((s) => s.key));
      continue;
    }
    // A Worker still bound by one that wasn't deleted would only be refused too.
    const stuck = new Set<string>();
    for (const step of todo) {
      if (step.target.kind === "worker_script" && step.target.boundBy?.some((name) => stuck.has(name))) {
        stuck.add(step.target.scriptName);
        result.notAttempted.push(step.key);
        continue;
      }
      try {
        await deleteTarget(api, account, plan.instanceId, step.target);
        result.deleted.push(step.key);
        context.onStep?.(step);
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status === 404) {
          result.deleted.push(step.key);
          continue;
        }
        // guarded() has already turned a credential failure into InstallerHaltedError.
        if (!(error instanceof CloudflareApiError)) throw error;
        if (step.target.kind === "worker_script") stuck.add(step.target.scriptName);
        result.failed.push({ key: step.key, reason: failureReason(step, error) });
      }
    }
  }
  return result;
}

async function deleteTarget(api: CloudflareApi, account: string, instanceId: string, target: UninstallTarget): Promise<void> {
  switch (target.kind) {
    case "managed_hostname":
      return await applyManagedHostname(api, account, instanceId, target.scriptName, target.ops);
    case "custom_domain":
      return await guarded(() => api.detachWorkerDomain(account, target.domainId!));
    case "worker_script":
      return await guarded(() => api.deleteWorkerScript(account, target.scriptName));
    case "access_application":
      return await guarded(() => api.deleteAccessApplication(account, target.appId!));
    case "access_policy":
      return await guarded(() => api.deleteAccessPolicy(account, target.policyId!));
    case "ai_gateway":
      return await guarded(() => api.deleteAiGateway(account, target.gatewayId));
    case "kv_namespace":
      return await guarded(() => api.deleteKvNamespace(account, target.namespaceId!));
    case "r2_bucket":
      return await guarded(() => api.deleteR2Bucket(account, target.name, target.jurisdiction));
    case "d1_database":
      return await guarded(() => api.deleteD1Database(account, target.databaseId!));
    case "dns_record":
      throw new EducateOsError("validation-failed", `the uninstall never deletes DNS record ${target.name}`);
  }
}

function failureReason(step: UninstallStep, error: CloudflareApiError): string {
  const codes = error.cloudflareCodes.length > 0 ? `, code ${error.cloudflareCodes.join(", ")}` : "";
  const what = error.status === 0 ? "no response from Cloudflare" : `Cloudflare refused (HTTP ${error.status}${codes})`;
  if (step.target.kind === "r2_bucket" && error.cloudflareCodes.includes(R2_BUCKET_NOT_EMPTY_CODE)) {
    return `${what}: the bucket still holds objects. Copy what the district must keep, empty it (a lifecycle rule that ` +
      `expires every object does it for a large bucket; a Bucket Lock rule keeps objects until it expires), then run uninstall again`;
  }
  if (step.target.kind === "worker_script" && error.cloudflareCodes.includes(10142)) {
    return `${what}: another Worker still binds it. Delete that Worker first, or run uninstall again once it is gone`;
  }
  return `${what}. Check it in the dashboard, then run uninstall again`;
}

/** What an uninstall run needs. */
export interface UninstallOptions {
  api: CloudflareApi;
  /** The install config the instance was installed with. */
  config: DistrictInstallConfig;
  /** The release the instance runs, which names its Workers and storage. */
  manifest: ReleaseManifest;
  /** Applies only when false. Planning, the default, changes nothing. */
  dryRun?: boolean;
  /** Must equal `config.instanceId` for the plan to be applied. */
  confirm?: string;
  onStep?: (step: UninstallStep) => void;
}

/** How an uninstall run ended. */
export type UninstallStatus =
  /** Planned only (a dry run); nothing changed. */
  | "planned"
  /** Not applied: the confirmation didn't match the instance ID. Nothing changed. */
  | "refused"
  /** Applied, and observation afterwards finds nothing of the instance's left to delete. */
  | "removed"
  /** Applied, but something failed or remains; `leftovers` says what. */
  | "incomplete";

/** The outcome of one uninstall run. */
export interface UninstallReport {
  status: UninstallStatus;
  plan: UninstallPlan;
  result?: UninstallResult;
  /**
   * After applying: what observation still finds, as step keys and unclaimed names. Kept resources
   * (`keep` steps) are in it, since a person must decide about them.
   */
  leftovers?: string[];
}

/**
 * Plans an instance's removal and, unless a dry run (the default), applies it once the operator has
 * confirmed with the instance ID, then observes the account again and reports what is left.
 */
export async function uninstall(options: UninstallOptions): Promise<UninstallReport> {
  const desired = compileDesiredState(options.manifest, options.config);
  const plan = await planUninstall(options.api, desired);
  if (options.dryRun !== false) return { status: "planned", plan };
  if (options.confirm !== options.config.instanceId) return { status: "refused", plan };
  const result = await applyUninstall(plan, { api: options.api, ...(options.onStep ? { onStep: options.onStep } : {}) });
  const after = await planUninstall(options.api, desired);
  const leftovers = [...after.steps.filter((s) => s.action !== "gone").map((s) => s.key), ...after.unclaimed];
  const clean = result.failed.length === 0 && after.steps.every((s) => s.action !== "delete");
  return { status: clean ? "removed" : "incomplete", plan, result, leftovers };
}

/**
 * The operator-facing lines for an uninstall report: the plan, then what applying did and what is
 * left. `confirmFlag` is how the calling CLI takes the confirmation, for the hint after a dry run.
 */
export function describeUninstall(report: UninstallReport, confirmFlag: string): string[] {
  const { plan } = report;
  const lines = [`uninstall plan for ${plan.instanceId} (${plan.hostname}) in account ${plan.accountId}:`];
  for (const step of plan.steps) lines.push(`${step.action.padEnd(7)} ${step.key}  ${step.reason}`);
  for (const name of plan.unclaimed) lines.push(`unclaimed ${name}  named like this instance's but not provably its own: not deleted; check it by hand`);
  if (plan.registered) {
    lines.push("registered: the instance registered with a registry, which keeps its record after the Workers are gone; " +
      "ask the registry's operator (for educateos.io, Gmacko Ventures) to deregister it");
  }
  switch (report.status) {
    case "planned":
      lines.push(`plan only; nothing was changed. To delete all of the above, run again with ${confirmFlag} ${plan.instanceId}`);
      break;
    case "refused":
      lines.push(`refused: the confirmation must be the instance ID, ${plan.instanceId}; nothing was changed`);
      break;
    default:
      for (const failure of report.result?.failed ?? []) lines.push(`FAILED  ${failure.key}  ${failure.reason}`);
      for (const key of report.result?.notAttempted ?? []) lines.push(`skipped ${key}  not attempted: an earlier step failed`);
      for (const key of report.leftovers ?? []) lines.push(`leftover ${key}`);
      lines.push(report.status === "removed"
        ? (report.leftovers?.length ? "uninstalled; the leftovers above were kept on purpose: decide about each" : "uninstalled; nothing of the instance is left")
        : "incomplete: fix what failed, then run uninstall again; it continues from what is left");
  }
  return lines;
}
