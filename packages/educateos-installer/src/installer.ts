// One installer run: compile, preflight, observe and plan, apply, register. The same function
// serves both install modes; only the CloudflareApi's token provider differs.
import { type ApplyResult, applyPlan } from "./apply.ts";
import type { ReleaseArtifacts } from "./artifacts.ts";
import type { CloudflareApi } from "./cloudflare-api.ts";
import { adminHostname, type DistrictInstallConfig, publicHostname, type SecretSource } from "./config.ts";
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
  /** What only a person can do after this install, in order. Absent when there is nothing. */
  nextSteps?: string[];
}

/**
 * The steps that finish an OSS admin install (SCHO-263), or none without one. The installer can't
 * enroll the admin with the district itself: the admin makes its ops key pair at enrollment and
 * keeps the private half sealed under a key the installer generated and does not keep, and the
 * district records which of its administrators enrolled each key. So a person copies the
 * registration across, as for any admin (docs/educateos/admin.md, "Install the OSS admin").
 */
export function adminNextSteps(config: DistrictInstallConfig): string[] {
  if (!config.admin.enabled) return [];
  const admin = `https://${adminHostname(config)}`;
  const district = `https://${publicHostname(config)}`;
  return [
    `Open the OSS admin at ${admin} as one of the install's admins, and enroll this district under Workspaces → Enroll (origin ${district}).`,
    `Copy the registration it shows, open ${district}/admin → Operations, paste it under Enroll an admin, and grant the scopes it asks for.`,
    `Back in the admin, choose Verify connection: the workspace becomes active.`,
  ];
}

/**
 * Runs the installer. Stops before any change when preflight or the plan is blocked, and returns
 * after planning on a dry run. Re-running after any interruption continues from what is deployed.
 */
export async function install(options: InstallOptions): Promise<InstallReport> {
  const { api, config } = options;
  const desired = compileDesiredState(options.manifest, config);
  const report = await preflight(api, config, desired, options.secrets);
  if (!report.ok) return { status: "preflight-blocked", preflight: report };

  const plan = await planInstall(api, desired, options.secrets);
  if (plan.blocked.length > 0) return { status: "plan-blocked", preflight: report, plan };
  const nextSteps = adminNextSteps(config);
  const steps = nextSteps.length > 0 ? { nextSteps } : {};
  if (options.dryRun) return { status: "planned", preflight: report, plan, ...steps };

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
  return { status: "applied", preflight: report, plan, applied, ...(registration ? { registration } : {}), ...steps };
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
  // A service the previous release does not ship cannot be part of its desired state; rollback
  // then returns the backend to a version without its binding and leaves the service running.
  const previousServices = Object.fromEntries(Object.entries(options.config.services)
    .filter(([name, wanted]) => !wanted.enabled || options.previous.workers[name]?.kind === "service"));
  // Likewise an OSS admin the previous release does not ship: it stays running, on its version.
  const previousHasAdmin = Object.values(options.previous.workers).some((w) => w.kind === "admin");
  const previous = compileDesiredState(options.previous, {
    ...options.config,
    services: previousServices,
    admin: previousHasAdmin ? options.config.admin : { enabled: false },
    release: { ...options.config.release, releaseId: options.previous.releaseId },
  });
  const plan = await planRollback(options.api, current, previous);
  if (options.dryRun) return { plan, deployed: [] };
  return { plan, deployed: await applyRollback(options.api, options.config.accountId, plan) };
}
