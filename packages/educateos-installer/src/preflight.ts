// Account preflight (roadmap §3.1 step 2, §9.1 step 2): before anything is created, check that the
// district's account has the products, quotas, DNS and identity setup the release needs, and name
// every action only the operator can take. It never bypasses consent or domain ownership: a
// missing zone or IdP is reported as an operator step, not worked around.
import type { CloudflareApi } from "./cloudflare-api.ts";
import { R2_NOT_ENABLED_CODE } from "./cloudflare-http.ts";
import type { DistrictInstallConfig, SecretSource } from "./config.ts";
import type { DesiredState, DesiredWorker } from "./desired.ts";
import { CloudflareApiError, isCredentialFailure } from "./errors.ts";

/** One finding. `code` is stable for programs; `message` is for the operator. */
export interface PreflightItem {
  code: string;
  message: string;
  /** What the operator must do, when it is something only they can do. */
  operatorAction?: string;
}

/** The preflight result. The install may proceed only when {@link PreflightReport.blocking} is empty. */
export interface PreflightReport {
  ok: boolean;
  blocking: PreflightItem[];
  warnings: PreflightItem[];
}

/**
 * Per-account resource limits on Workers Paid, from Cloudflare's published limits. They can be
 * raised on request and are not read from the account, so a count near one is a warning only
 * until the create itself fails. Unverified against a live account.
 */
export const DOCUMENTED_LIMITS = {
  workerScripts: 500,
  kvNamespaces: 1000,
  d1Databases: 50_000,
  r2Buckets: 1_000_000,
} as const;

/** Rate plan IDs that include Workers Paid. Unverified beyond `workers_paid`. */
const WORKERS_PAID_PLANS = new Set(["workers_paid", "workers_bundled", "workers_unbound", "enterprise"]);

/** Cloudflare's documented size limit for one Workers environment variable, in bytes. Unverified. */
export const WORKER_VAR_LIMIT_BYTES = 5 * 1024;

/** Zero Trust Free allows this many users; a district needs a paid seat plan. */
const ZERO_TRUST_FREE_SEATS = 50;

/**
 * Runs every preflight check. Credential failures are findings, not exceptions. With `secrets`, an
 * installed service's secret input is also checked: it must be supplied, or already set on the
 * service's Worker by an earlier install (values are never read back).
 */
export async function preflight(
  api: CloudflareApi,
  config: DistrictInstallConfig,
  desired: DesiredState,
  secrets?: SecretSource,
): Promise<PreflightReport> {
  const blocking: PreflightItem[] = [];
  const warnings: PreflightItem[] = [];
  const account = config.accountId;

  // A probe records why a call failed and returns `failed`, so one missing permission is one
  // finding and the remaining checks still run.
  const probe: Probe = async (what, scope, call, severity = "blocking") => {
    try {
      return { failed: false, value: await call() };
    } catch (error) {
      const into = severity === "blocking" ? blocking : warnings;
      if (isCredentialFailure(error)) {
        into.push(error.code === "unauthenticated"
          ? { code: "credential.rejected", message: `Cloudflare rejected the credential while ${what}.`, operatorAction: "Re-authorize the installer or supply a valid API token." }
          : { code: "permission.missing", message: `The credential may not ${what}.`, operatorAction: `Grant the token the "${scope}" permission.` });
      } else {
        into.push({ code: "cloudflare.unavailable", message: `Could not finish ${what}: ${error instanceof Error ? error.message : "unknown error"}.` });
      }
      return { failed: true };
    }
  };

  const accountInfo = await probe("reading the account", "Account Settings: Read", () => api.getAccount(account));
  if (accountInfo.failed) {
    return { ok: false, blocking, warnings };
  }

  const workers = desired.resources.filter((r): r is DesiredWorker => r.kind === "worker_script");
  const bindingTypes = new Set(workers.flatMap((w) => w.bindings.map((b) => b.type)));
  const count = (kind: string) => desired.resources.filter((r) => r.kind === kind).length;

  const plans = await probe("reading plan subscriptions", "Billing: Read", () => api.listSubscriptions(account));
  const subscriptions = plans.failed ? undefined : plans.value;
  if (subscriptions && !subscriptions.some((s) => WORKERS_PAID_PLANS.has(s.ratePlanId))) {
    blocking.push({
      code: "plan.workers-paid-required",
      message: "The account is not on Workers Paid. EducateOS needs it for Durable Object volume and per-request CPU limits a district's traffic exceeds on Free.",
      operatorAction: "Subscribe the account to Workers Paid (Workers & Pages → Plans).",
    });
  }
  if (subscriptions && !subscriptions.some((s) => s.ratePlanId.startsWith("teams_") && s.ratePlanId !== "teams_free")) {
    warnings.push({
      code: "access.free-seat-limit",
      message: `No paid Zero Trust plan found. Zero Trust Free admits ${ZERO_TRUST_FREE_SEATS} users; every student and teacher who signs in takes a seat.`,
      operatorAction: "Buy Zero Trust seats for the pilot population before activation.",
    });
  }

  if (count("r2_bucket") > 0) {
    try {
      const buckets = await api.listR2Buckets(account);
      quota(warnings, blocking, "r2Buckets", "R2 buckets", buckets.length, count("r2_bucket"));
    } catch (error) {
      if (error instanceof CloudflareApiError && error.cloudflareCodes.includes(R2_NOT_ENABLED_CODE)) {
        blocking.push({
          code: "product.r2-not-enabled",
          message: "R2 is not enabled on this account.",
          operatorAction: "Enable R2 in the dashboard (R2 Object Storage → Purchase R2 Plan); it needs a payment method even within the free allowance.",
        });
      } else {
        await probe("listing R2 buckets", "Workers R2 Storage: Edit", () => Promise.reject(error as Error));
      }
    }
  }

  const scripts = await probe("listing Workers", "Workers Scripts: Edit", () => api.listWorkerScripts(account));
  if (!scripts.failed) {
    const existing = new Set(scripts.value.map((s) => s.name));
    quota(warnings, blocking, "workerScripts", "Workers", existing.size, workers.filter((w) => !existing.has(w.scriptName)).length);
  }
  if (count("kv_namespace") > 0) {
    const kv = await probe("listing KV namespaces", "Workers KV Storage: Edit", () => api.listKvNamespaces(account));
    if (!kv.failed) quota(warnings, blocking, "kvNamespaces", "KV namespaces", kv.value.length, count("kv_namespace"));
  }
  if (count("d1_database") > 0) {
    const d1 = await probe("listing D1 databases", "D1: Edit", () => api.listD1Databases(account));
    if (!d1.failed) quota(warnings, blocking, "d1Databases", "D1 databases", d1.value.length, count("d1_database"));
  }
  await checkServiceInputs(api, config, desired, secrets, scripts.failed ? undefined : new Set(scripts.value.map((s) => s.name)), blocking, warnings);
  if (bindingTypes.has("worker_loader")) {
    warnings.push({
      code: "product.worker-loader",
      message: "The release uses the Worker Loader (dynamic Workers) binding. Its availability on this account is not checked by the API.",
      operatorAction: "Confirm Worker Loader is enabled for the account before activation.",
    });
  }

  await checkAccess(probe, api, config, blocking);
  await checkDns(probe, api, config, desired.hostname, blocking);

  if (config.aiGateway) {
    // Optional product: a failure here is a warning, and the install still tries to create it.
    await probe("listing AI Gateways", "AI Gateway: Edit", () => api.listAiGateways(account), "warning");
  }

  return { ok: blocking.length === 0, blocking, warnings };
}

async function checkServiceInputs(
  api: CloudflareApi,
  config: DistrictInstallConfig,
  desired: DesiredState,
  secrets: SecretSource | undefined,
  existingScripts: Set<string> | undefined,
  blocking: PreflightItem[],
  warnings: PreflightItem[],
) {
  const scriptOf = new Map(desired.resources.flatMap((r) => (r.kind === "worker_script" ? [[r.pkgName, r.scriptName]] : [])));
  const setSecrets = new Map<string, Set<string>>();
  for (const input of desired.inputs) {
    const where = `services["${input.pkgName}"]`;
    if (input.kind === "var") {
      const value = config.services[input.pkgName]?.vars[input.name];
      if (!input.supplied || value === undefined) {
        blocking.push({
          code: "service.input-missing",
          message: `${input.pkgName} needs ${input.name} (${input.label}).`,
          operatorAction: `Set ${where}.vars.${input.name} in the install config.`,
        });
      } else if (new TextEncoder().encode(value).byteLength > WORKER_VAR_LIMIT_BYTES) {
        warnings.push({
          code: "service.var-size",
          message: `${input.pkgName}'s ${input.name} is over Cloudflare's documented ${WORKER_VAR_LIMIT_BYTES}-byte variable limit; the upload may be refused.`,
        });
      }
      continue;
    }
    if (!secrets || secrets.get(input.pkgName, input.name) !== undefined) continue;
    const scriptName = scriptOf.get(input.pkgName);
    if (scriptName && existingScripts?.has(scriptName)) {
      if (!setSecrets.has(scriptName)) {
        try {
          setSecrets.set(scriptName, new Set(await api.listWorkerSecrets(config.accountId, scriptName)));
        } catch {
          setSecrets.set(scriptName, new Set());
        }
      }
      if (setSecrets.get(scriptName)!.has(input.name)) continue;
    }
    blocking.push({
      code: "service.secret-missing",
      message: `${input.pkgName} needs the secret ${input.name} (${input.label}), and it is neither supplied nor set on the Worker.`,
      operatorAction: `Supply ${input.name} for ${input.pkgName} through the installer's secret source (the CLI reads EDUCATEOS_SECRET_${input.pkgName.toUpperCase().replaceAll("-", "_")}__${input.name}).`,
    });
  }
}

type ProbeResult<T> = { failed: false; value: T } | { failed: true };
type Probe = <T>(what: string, scope: string, call: () => Promise<T>, severity?: "blocking" | "warning") => Promise<ProbeResult<T>>;

async function checkAccess(probe: Probe, api: CloudflareApi, config: DistrictInstallConfig, blocking: PreflightItem[]) {
  const account = config.accountId;
  const expected = `${config.access.teamName}.cloudflareaccess.com`;
  let organization;
  try {
    organization = await api.getAccessOrganization(account);
  } catch (error) {
    await probe("reading the Zero Trust organization", "Access: Organizations, Identity Providers, and Groups: Read", () => Promise.reject(error as Error));
    return;
  }
  if (!organization) {
    blocking.push({
      code: "access.organization-missing",
      message: "Cloudflare Zero Trust is not set up on this account.",
      operatorAction: `Open Zero Trust in the dashboard and create the team "${config.access.teamName}".`,
    });
    return;
  }
  if (organization.authDomain !== expected) {
    blocking.push({
      code: "access.team-mismatch",
      message: `The account's Zero Trust team is ${organization.authDomain}, not ${expected}.`,
      operatorAction: `Set access.teamName in the install config to the account's team.`,
    });
  }
  const idps = await probe("listing identity providers", "Access: Organizations, Identity Providers, and Groups: Read", () => api.listAccessIdentityProviders(account));
  if (!idps.failed && !idps.value.some((idp) => idp.type !== "onetimepin")) {
    blocking.push({
      code: "access.idp-missing",
      message: "Zero Trust has no district identity provider; only one-time email codes are configured.",
      operatorAction: "Add the district's SAML or OIDC identity provider (Zero Trust → Settings → Authentication), so students and staff sign in with district SSO.",
    });
  }
}

async function checkDns(probe: Probe, api: CloudflareApi, config: DistrictInstallConfig, hostname: string, blocking: PreflightItem[]) {
  const found = await probe("reading zones", "Zone: Read", () => api.findZone(config.accountId, config.baseDomain));
  if (found.failed) return;
  const zone = found.value;
  if (zone === undefined) {
    blocking.push({
      code: "dns.zone-missing",
      message: `The zone ${config.baseDomain} is not in this Cloudflare account.`,
      operatorAction: `Add ${config.baseDomain} to the account and change its nameservers at the registrar to the ones Cloudflare assigns.`,
    });
    return;
  }
  if (zone.status !== "active") {
    blocking.push({
      code: "dns.zone-pending",
      message: `The zone ${config.baseDomain} is ${zone.status}: its nameservers do not point at Cloudflare yet.`,
      operatorAction: `Finish the nameserver change for ${config.baseDomain} at the registrar and wait for Cloudflare to mark the zone active.`,
    });
  }
  const records = await probe(`reading DNS records for ${hostname}`, "DNS: Read", () => api.listDnsRecords(zone.id, hostname));
  const domains = await probe("listing Worker custom domains", "Workers Scripts: Edit", () => api.listWorkerDomains(config.accountId));
  const attached = !domains.failed && domains.value.some((d) => d.hostname === hostname);
  if (!records.failed && records.value.length > 0 && !attached) {
    blocking.push({
      code: "dns.record-conflict",
      message: `${hostname} already has DNS records (${records.value.map((r) => r.type).join(", ")}). A Workers custom domain needs the name free.`,
      operatorAction: `Delete the existing records for ${hostname}, or choose another subdomain in the install config.`,
    });
  }
}

function quota(
  warnings: PreflightItem[],
  blocking: PreflightItem[],
  limit: keyof typeof DOCUMENTED_LIMITS,
  label: string,
  existing: number,
  adding: number,
) {
  const max = DOCUMENTED_LIMITS[limit];
  if (existing + adding > max) {
    blocking.push({
      code: `quota.${limit}`,
      message: `The account has ${existing} ${label}; the install adds up to ${adding}, over the documented limit of ${max}.`,
      operatorAction: `Delete unused ${label} or ask Cloudflare to raise the limit.`,
    });
  } else if (existing + adding > max * 0.8) {
    warnings.push({ code: `quota.${limit}`, message: `The install brings the account to ${existing + adding} of ${max} ${label}.` });
  }
}
