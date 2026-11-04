// One run against an account: preflight and plan (both read-only), the operator's confirmation,
// then apply with live progress, and the URLs and next steps at the end. Every step is the
// installer library's own (`install`, `rollback`); this file only shows them to a person or a CI
// job. The installer is idempotent and keeps no local state, so re-running continues from
// whatever is already in the account.
import {
  adminHostname,
  type CostLine,
  type DesiredWorkerSecret,
  type DistrictInstallConfig,
  install,
  type InstallPlan,
  MANAGED_ZONE,
  MARKER_VARS,
  type PlanStep,
  type PreflightReport,
  publicHostname,
  type RegistryEndpoint,
  type ReleaseManifest,
  rollback,
  type SecretSource,
  compileDesiredState,
} from "@educateos/installer";
import type { LaunchCloudflare } from "./cloudflare.ts";
import type { Output } from "./output.ts";
import type { Prompter } from "./prompter.ts";
import type { VerifiedRelease } from "./release-source.ts";

/** The environment variable a gatekeeper's or service's secret is read from, as the installer CLI names it. */
export function secretEnvName(pkg: string, name: string): string {
  return `EDUCATEOS_SECRET_${pkg.toUpperCase().replaceAll("-", "_")}__${name}`;
}

/**
 * Secrets from `EDUCATEOS_SECRET_<PACKAGE>__<NAME>`, plus any the operator typed during this run.
 * Values stay in memory and are registered with the output for redaction.
 */
export class LaunchSecrets implements SecretSource {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #typed = new Map<string, string>();
  readonly #out: Output;

  constructor(env: Readonly<Record<string, string | undefined>>, out: Output) {
    this.#env = env;
    this.#out = out;
    for (const [name, value] of Object.entries(env)) if (name.startsWith("EDUCATEOS_SECRET_")) out.secret(value);
  }

  get(pkgName: string, secretName: string): string | undefined {
    return this.#typed.get(`${pkgName}/${secretName}`) ?? (this.#env[secretEnvName(pkgName, secretName)] || undefined);
  }

  set(pkgName: string, secretName: string, value: string): void {
    this.#out.secret(value);
    this.#typed.set(`${pkgName}/${secretName}`, value);
  }
}

/** What a run needs besides the release and config. */
export interface RunContext {
  out: Output;
  cf: LaunchCloudflare;
  /** Undefined for a non-interactive run. */
  prompter: Prompter | undefined;
  /** Apply without asking. */
  yes: boolean;
  secrets: LaunchSecrets;
}

const SYMBOL: Record<string, string> = { create: "+", update: "~", delete: "-", refuse: "!", "needs-input": "?", noop: "=" };

function printPreflight(out: Output, report: PreflightReport): void {
  out.event({ event: "preflight", ok: report.ok, blocking: report.blocking, warnings: report.warnings });
  out.line(report.ok ? "Preflight: ready." : "Preflight: blocked. Nothing was changed.");
  for (const item of report.blocking) {
    out.line(`  BLOCKING  ${item.message} (${item.code})`);
    if (item.operatorAction) out.line(`            What to do: ${item.operatorAction}`);
  }
  for (const item of report.warnings) {
    out.line(`  warning   ${item.message} (${item.code})`);
    if (item.operatorAction) out.line(`            What to do: ${item.operatorAction}`);
  }
}

const stepView = (step: PlanStep) => ({ action: step.action, key: step.key, reason: step.reason });

function printPlan(out: Output, plan: InstallPlan): void {
  const changing = plan.steps.filter((step) => step.action !== "noop");
  out.event({ event: "plan", steps: changing.map(stepView), blocked: plan.blocked.map(stepView), cost: plan.cost });
  const unchanged = plan.steps.length - changing.length;
  out.line();
  out.line(changing.length === 0
    ? `Plan: nothing to change (${unchanged} resources already match this release).`
    : `Plan: ${changing.length} change(s), ${unchanged} resource(s) already up to date.`);
  for (const step of changing) out.line(`  ${SYMBOL[step.action] ?? "?"} ${step.action.padEnd(11)} ${step.key}  (${step.reason})`);
  printCost(out, plan.cost);
}

function printCost(out: Output, cost: CostLine[]): void {
  if (cost.length === 0) return;
  out.line();
  out.line("Billable resources in your Cloudflare account (billed to you by Cloudflare, not by EducateOS):");
  for (const line of cost) out.line(`  ${line.product.padEnd(30)} ${line.total} in all, ${line.creating} new  (${line.billedBy})`);
}

/** The district package a release's router serves at the root of a one-origin install, if any. */
export function districtPackage(manifest: ReleaseManifest): string | undefined {
  const router = Object.values(manifest.workers).find((worker) => worker.kind === "router");
  return /^\$WORKER_NAME\(([a-z0-9-]+)\)$/.exec(router?.districtOrigin?.binding.service ?? "")?.[1];
}

/** Whether an install puts the district LMS at the root of its hostname (ADR-0014). */
export function isOneOrigin(config: DistrictInstallConfig, manifest: ReleaseManifest): boolean {
  const pkg = districtPackage(manifest);
  return pkg !== undefined && config.services[pkg]?.enabled === true;
}

/** The addresses an install serves, by what they are. */
export function installUrls(config: DistrictInstallConfig, manifest: ReleaseManifest): Record<string, string> {
  const host = `https://${publicHostname(config)}`;
  const urls: Record<string, string> = {};
  if (isOneOrigin(config, manifest)) {
    const router = Object.values(manifest.workers).find((worker) => worker.kind === "router");
    urls.district = `${host}/`;
    if (config.ai.enabled) urls.ai = `${host}${router?.districtOrigin?.basePath ?? "/ai"}/`;
  } else {
    urls.workshop = `${host}/`;
  }
  const admin = adminHostname(config);
  if (config.admin.enabled && admin !== undefined) urls.admin = `https://${admin}/`;
  if (config.managedHostname && config.baseDomain !== undefined) urls.managed = `https://${config.managedHostname.slug}.${MANAGED_ZONE}/`;
  return urls;
}

const URL_LABELS: Record<string, string> = {
  district: "District (LMS)",
  ai: "AI Workshop",
  workshop: "AI Workshop",
  admin: "OSS admin",
  managed: "Also at",
};

/** What the operator does next, in order. */
export function nextSteps(config: DistrictInstallConfig, manifest: ReleaseManifest, adminSteps: string[]): string[] {
  const urls = installUrls(config, manifest);
  const who = [...config.access.allowedEmailDomains.map((domain) => `anyone @${domain}`), ...config.access.allowedEmails].join(", ");
  const steps = [`Sign in at ${urls.district ?? urls.workshop} through Cloudflare Access (${who} may sign in). The administrators are ${config.admins.join(", ")}.`];
  if (urls.district) {
    steps.push(`Set up the district at ${urls.district}admin: import your roster or add people and classes there. For demo content, add sample courses from the district course library.`);
  }
  steps.push(...adminSteps);
  steps.push("Delete the Cloudflare API token you used: https://dash.cloudflare.com/profile/api-tokens. Create a new one when you next upgrade.");
  steps.push("Keep educateos-install.json (it holds no secrets): `npx launch-educate-os upgrade` installs newer releases, and `npx launch-educate-os rollback` returns to the previous one.");
  return steps;
}

/** The secrets the plan still needs, with what the release says about each. */
function missingSecrets(plan: InstallPlan, manifest: ReleaseManifest) {
  return plan.steps.filter((step) => step.action === "needs-input" && step.kind === "worker_secret").map((step) => {
    const resource = step.resource as DesiredWorkerSecret;
    const input = manifest.workers[resource.pkgName]?.inputs?.find((candidate) => candidate.name === resource.secretName);
    return { pkg: resource.pkgName, name: resource.secretName, input };
  });
}

/** Asks for each secret the plan needs. Returns whether any was supplied. */
async function askForSecrets(context: RunContext, plan: InstallPlan, manifest: ReleaseManifest): Promise<boolean> {
  const missing = missingSecrets(plan, manifest);
  if (missing.length === 0 || context.prompter === undefined) return false;
  context.out.line();
  context.out.line(`The release needs ${missing.length} secret(s) it can't generate. Leave one blank to stop and supply it later as an environment variable.`);
  let supplied = false;
  for (const { pkg, name, input } of missing) {
    context.out.line();
    context.out.line(`${pkg}: ${input?.label ?? name}`);
    if (input?.help) context.out.line(`  ${input.help}`);
    if (input?.consoleUrl) context.out.line(`  Get it at ${input.consoleUrl}`);
    for (const step of input?.setupSteps ?? []) context.out.line(`  - ${step}`);
    const value = await context.prompter.secret(`  ${name}`);
    if (value === "") continue;
    context.secrets.set(pkg, name, value);
    supplied = true;
  }
  return supplied;
}

/** What {@link installRelease} is asked to do. */
export interface InstallRequest {
  config: DistrictInstallConfig;
  release: VerifiedRelease;
  planOnly: boolean;
  registry?: RegistryEndpoint;
}

/** How a run ended: the process exit code, and whether the release is now applied. */
export interface RunOutcome {
  exitCode: number;
  applied: boolean;
}

/**
 * Preflight, plan, confirm, apply. Changes nothing unless preflight passes, the plan is unblocked
 * and the operator agrees (or passed `--yes`).
 */
export async function installRelease(context: RunContext, request: InstallRequest): Promise<RunOutcome> {
  const { out, cf, secrets } = context;
  const { config, release } = request;
  const base = { api: cf.api, config, manifest: release.manifest, artifacts: release.artifacts, secrets };

  out.line();
  out.line("Checking your account (read-only)...");
  let report = await install({ ...base, dryRun: true });
  printPreflight(out, report.preflight);
  if (report.status === "preflight-blocked") {
    out.line();
    out.line("Fix the blocking items above, then run the same command again. Your answers are saved.");
    return { exitCode: 1, applied: false };
  }
  if (await askForSecrets(context, report.plan!, release.manifest)) report = await install({ ...base, dryRun: true });
  const plan = report.plan!;
  printPlan(out, plan);

  if (report.status === "plan-blocked") {
    out.line();
    out.line("The plan is blocked, so nothing was changed:");
    for (const step of plan.blocked) out.line(`  ! ${step.key}: ${step.reason}`);
    const missing = missingSecrets(plan, release.manifest);
    if (missing.length > 0) {
      out.line("Supply the missing secrets as environment variables and run again:");
      for (const { pkg, name } of missing) out.line(`  ${secretEnvName(pkg, name)}`);
    }
    return { exitCode: 1, applied: false };
  }
  const changes = plan.steps.filter((step) => step.action !== "noop").length;
  if (request.planOnly) {
    out.line();
    out.line("Plan only: nothing was changed. Run without --plan-only to apply it.");
    out.event({ event: "done", status: "planned", urls: installUrls(config, release.manifest), nextSteps: [] });
    return { exitCode: 0, applied: false };
  }
  if (!context.yes) {
    if (context.prompter === undefined) {
      out.line("Not applying: pass --yes to apply without a terminal to confirm on.");
      return { exitCode: 2, applied: false };
    }
    out.line();
    const go = await context.prompter.confirm(changes === 0 ? "Nothing to change. Re-check and finish?" : `Apply these ${changes} change(s) to your account?`, true);
    if (!go) {
      out.line("Nothing was changed.");
      return { exitCode: 1, applied: false };
    }
  }

  out.line();
  out.line(`Installing ${release.releaseId} (${release.statement.version})...`);
  let index = 0;
  const applied = await install({
    ...base,
    ...(request.registry ? { registry: request.registry } : {}),
    onStep: (step) => {
      index++;
      out.event({ event: "step", index, total: changes, action: step.action, key: step.key });
      out.line(`  [${String(index).padStart(String(changes).length)}/${changes}] ${step.action.padEnd(7)} ${step.key}`);
    },
  });
  if (applied.status !== "applied") {
    // The account changed between the plan and the apply; nothing was applied.
    printPreflight(out, applied.preflight);
    for (const step of applied.plan?.blocked ?? []) out.line(`  ! ${step.key}: ${step.reason}`);
    out.line("The account changed since the plan, and the install stopped before changing anything. Run again.");
    return { exitCode: 1, applied: false };
  }
  if (applied.registration) out.line(`Registration: ${applied.registration.status}`);

  const urls = installUrls(config, release.manifest);
  const steps = nextSteps(config, release.manifest, applied.nextSteps ?? []);
  out.event({ event: "done", status: "applied", urls, nextSteps: steps });
  out.line();
  out.line(`EducateOS ${release.statement.version} is installed.`);
  for (const [kind, url] of Object.entries(urls)) out.line(`  ${(URL_LABELS[kind] ?? kind).padEnd(16)} ${url}`);
  out.line();
  out.line("Next steps:");
  steps.forEach((step, i) => out.line(`  ${i + 1}. ${step}`));
  return { exitCode: 0, applied: true };
}

/** What {@link rollbackRelease} is asked to do. */
export interface RollbackRequest {
  config: DistrictInstallConfig;
  current: VerifiedRelease;
  previous: VerifiedRelease;
  planOnly: boolean;
}

/** Plans the rollback, shows what can't be undone, confirms, and redeploys the previous versions. */
export async function rollbackRelease(context: RunContext, request: RollbackRequest): Promise<RunOutcome> {
  const { out, cf } = context;
  const base = { api: cf.api, config: request.config, current: request.current.manifest, previous: request.previous.manifest };
  const { plan } = await rollback({ ...base, dryRun: true });
  out.event({
    event: "rollback",
    fromReleaseId: plan.fromReleaseId,
    toReleaseId: plan.toReleaseId,
    steps: plan.steps.map(({ action, scriptName, reason }) => ({ action, scriptName, reason })),
    irreversible: plan.irreversible,
  });
  out.line();
  out.line(`Rollback plan: ${plan.fromReleaseId} -> ${plan.toReleaseId}`);
  for (const step of plan.steps) out.line(`  ${step.action.padEnd(16)} ${step.scriptName}  (${step.reason})`);
  for (const note of plan.irreversible) out.line(`  not undone       ${note}`);
  if (plan.blocked.length > 0) {
    out.line("The rollback is blocked, so nothing was changed.");
    return { exitCode: 1, applied: false };
  }
  if (request.planOnly) {
    out.line("Plan only: nothing was changed.");
    return { exitCode: 0, applied: false };
  }
  if (!context.yes) {
    if (context.prompter === undefined) {
      out.line("Not rolling back: pass --yes to roll back without a terminal to confirm on.");
      return { exitCode: 2, applied: false };
    }
    if (!(await context.prompter.confirm(`Roll back to ${plan.toReleaseId}?`, false))) {
      out.line("Nothing was changed.");
      return { exitCode: 1, applied: false };
    }
  }
  const { deployed } = await rollback(base);
  out.line(`Rolled back ${deployed.length} Worker(s) to ${plan.toReleaseId}.`);
  out.event({ event: "done", status: "rolled-back", urls: installUrls(request.config, request.previous.manifest), nextSteps: [] });
  return { exitCode: 0, applied: true };
}

/**
 * The release the account's backend Worker runs, read from the installer's marker on it, or
 * undefined when the instance isn't installed (or can't be read; preflight then says why).
 */
export async function deployedReleaseId(cf: LaunchCloudflare, config: DistrictInstallConfig, manifest: ReleaseManifest): Promise<string | undefined> {
  try {
    const backend = compileDesiredState(manifest, config).resources.find((r) => r.kind === "worker_script" && r.role === "backend");
    if (backend?.kind !== "worker_script") return undefined;
    const scripts = await cf.api.listWorkerScripts(config.accountId);
    if (!scripts.some((script) => script.name === backend.scriptName)) return undefined;
    const settings = await cf.api.getWorkerSettings(config.accountId, backend.scriptName);
    const marker = (name: string) => settings.bindings.find((b) => b.type === "plain_text" && b.name === name)?.text;
    if (marker(MARKER_VARS.instance) !== config.instanceId) return undefined;
    return marker(MARKER_VARS.release);
  } catch {
    return undefined;
  }
}
