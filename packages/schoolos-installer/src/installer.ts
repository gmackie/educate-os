// One installer run: compile, preflight, observe and plan, apply, register. The same function
// serves both install modes; only the CloudflareApi's token provider differs.
import { type ApplyResult, applyPlan } from "./apply.ts";
import type { ReleaseArtifacts } from "./artifacts.ts";
import type { CloudflareApi } from "./cloudflare-api.ts";
import type { DistrictInstallConfig, SecretSource } from "./config.ts";
import { compileDesiredState } from "./desired.ts";
import { type RegistrationOutcome, type RegistryEndpoint, registerWithFleet } from "./fleet-registration.ts";
import type { ReleaseManifest } from "./manifest.ts";
import { type InstallPlan, planInstall, type PlanStep } from "./plan.ts";
import { type PreflightReport, preflight } from "./preflight.ts";
import { applyRollback, planRollback, type RollbackPlan } from "./rollback.ts";

/** What an installer run needs. */
export interface InstallOptions {
  api: CloudflareApi;
  config: DistrictInstallConfig;
  manifest: ReleaseManifest;
  artifacts: ReleaseArtifacts;
  secrets: SecretSource;
  /** Observe and plan only; change nothing. */
  dryRun?: boolean;
  /** Where to register after a successful apply. Without it, or without `config.fleet`, the run does not register. */
  registry?: RegistryEndpoint;
  onStep?: (step: PlanStep) => void;
  now?: () => Date;
}

/** How a run ended. Credential failures are not here: they throw InstallerHaltedError. */
export type InstallStatus = "preflight-blocked" | "plan-blocked" | "planned" | "applied";

/** The outcome of one installer run. */
export interface InstallReport {
  status: InstallStatus;
  preflight: PreflightReport;
  plan?: InstallPlan;
  applied?: ApplyResult;
  registration?: RegistrationOutcome;
}

/**
 * Runs the installer. Stops before any change when preflight or the plan is blocked, and returns
 * after planning on a dry run. Re-running after any interruption continues from what is deployed.
 */
export async function install(options: InstallOptions): Promise<InstallReport> {
  const { api, config } = options;
  const desired = compileDesiredState(options.manifest, config);
  const report = await preflight(api, config, desired);
  if (!report.ok) return { status: "preflight-blocked", preflight: report };

  const plan = await planInstall(api, desired, options.secrets);
  if (plan.blocked.length > 0) return { status: "plan-blocked", preflight: report, plan };
  if (options.dryRun) return { status: "planned", preflight: report, plan };

  const applied = await applyPlan(plan, {
    api,
    artifacts: options.artifacts,
    secrets: options.secrets,
    ...(options.onStep ? { onStep: options.onStep } : {}),
  });

  let registration: RegistrationOutcome | undefined;
  if (config.fleet && options.registry) {
    const backend = desired.resources.find((r) => r.kind === "worker_script" && r.role === "backend");
    if (backend?.kind === "worker_script") {
      registration = await registerWithFleet({
        api,
        accountId: config.accountId,
        instanceId: config.instanceId,
        backendScript: backend.scriptName,
        endpoint: options.registry,
        details: { ...config.fleet, releaseVersion: config.release.version },
        ...(options.now ? { now: options.now } : {}),
      });
    }
  }
  return { status: "applied", preflight: report, plan, applied, ...(registration ? { registration } : {}) };
}

/** What a rollback needs: the release now installed and the one to return to. */
export interface RollbackOptions {
  api: CloudflareApi;
  config: DistrictInstallConfig;
  current: ReleaseManifest;
  previous: ReleaseManifest;
  dryRun?: boolean;
}

/** Plans, and unless a dry run applies, a rollback to the previous release. */
export async function rollback(options: RollbackOptions): Promise<{ plan: RollbackPlan; deployed: string[] }> {
  const current = compileDesiredState(options.current, options.config);
  const previous = compileDesiredState(options.previous, { ...options.config, release: { ...options.config.release, releaseId: options.previous.releaseId } });
  const plan = await planRollback(options.api, current, previous);
  if (options.dryRun) return { plan, deployed: [] };
  return { plan, deployed: await applyRollback(options.api, options.config.accountId, plan) };
}
