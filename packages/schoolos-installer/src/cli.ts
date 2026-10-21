// District-run installer CLI. The district runs it itself (or from its own CI) with an API token
// it created; the root's OAuth path uses the library directly.
//
//   pnpm --filter @schoolos/installer start <command> --config install.json --manifest release/manifest.json
//
//   preflight   check the account, products, quotas, DNS and Access setup
//   plan        preflight, then observe and print the plan (changes nothing)
//   apply       preflight, plan and apply; then register with the root if --registry-url is given
//   rollback    return to a previous release: --previous-manifest <file> --previous-pin <releaseId>@<sha256>
//
// The token is read from CLOUDFLARE_API_TOKEN. Gatekeeper secrets are read from
// SCHOOLOS_SECRET_<PACKAGE>__<NAME>, e.g. SCHOOLOS_SECRET_GATEKEEPER_GOOGLE__CLIENT_ID. Neither is
// ever printed. Release blobs are read from the manifest's directory (build-release.ts layout)
// unless --release-dir says otherwise.
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { SchoolOsError } from "@schoolos/contracts";
import { z } from "zod";
import { CloudflareHttpApi } from "./cloudflare-http.ts";
import { DistrictInstallConfig, type SecretSource } from "./config.ts";
import { DirectoryReleaseArtifacts } from "./directory-artifacts.ts";
import { InstallerHaltedError } from "./errors.ts";
import { httpRegistryEndpoint } from "./fleet-registration.ts";
import { install, rollback } from "./installer.ts";
import { loadPinnedManifest } from "./manifest.ts";
import type { PreflightReport } from "./preflight.ts";
import { districtRunTokenProvider } from "./token.ts";

const COMMANDS = ["preflight", "plan", "apply", "rollback"] as const;

function secretEnvName(pkg: string, name: string): string {
  return `SCHOOLOS_SECRET_${pkg.toUpperCase().replaceAll("-", "_")}__${name}`;
}

function envSecretSource(env: NodeJS.ProcessEnv): SecretSource {
  return { get: (pkg, name) => env[secretEnvName(pkg, name)] || undefined };
}

async function readBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await readFile(path);
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

function printPreflight(report: PreflightReport): void {
  for (const item of report.blocking) {
    console.log(`BLOCKING ${item.code}: ${item.message}`);
    if (item.operatorAction) console.log(`  operator: ${item.operatorAction}`);
  }
  for (const item of report.warnings) {
    console.log(`warning  ${item.code}: ${item.message}`);
    if (item.operatorAction) console.log(`  operator: ${item.operatorAction}`);
  }
  console.log(report.ok ? "preflight: ok" : "preflight: blocked");
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      manifest: { type: "string" },
      "release-dir": { type: "string" },
      "registry-url": { type: "string" },
      "previous-manifest": { type: "string" },
      "previous-pin": { type: "string" },
    },
  });
  const command = positionals[0] as (typeof COMMANDS)[number] | undefined;
  if (!command || !COMMANDS.includes(command) || !values.config || !values.manifest) {
    console.error(`usage: cli.ts <${COMMANDS.join("|")}> --config <file> --manifest <file> [--release-dir <dir>] [--registry-url <url>]`);
    return 2;
  }

  const parsed = DistrictInstallConfig.safeParse(JSON.parse(await readFile(values.config, "utf8")));
  if (!parsed.success) {
    console.error(`install config rejected:\n${z.prettifyError(parsed.error)}`);
    return 2;
  }
  const config = parsed.data;
  const manifest = await loadPinnedManifest(await readBytes(values.manifest), config.release);
  const api = new CloudflareHttpApi({ tokens: districtRunTokenProvider(process.env) });

  if (command === "rollback") {
    const [releaseId, manifestSha256] = (values["previous-pin"] ?? "").split("@");
    if (!values["previous-manifest"] || !releaseId || !manifestSha256) {
      console.error("rollback needs --previous-manifest <file> and --previous-pin <releaseId>@<sha256>");
      return 2;
    }
    const previous = await loadPinnedManifest(await readBytes(values["previous-manifest"]), {
      ...config.release,
      releaseId,
      manifestSha256,
    });
    const { plan, deployed } = await rollback({ api, config, current: manifest, previous });
    for (const step of plan.steps) console.log(`${step.action.padEnd(16)} ${step.scriptName}  ${step.reason}`);
    for (const note of plan.irreversible) console.log(`irreversible     ${note}`);
    console.log(`rolled back ${deployed.length} Worker(s) to ${plan.toReleaseId}`);
    return 0;
  }

  const report = await install({
    api,
    config,
    manifest,
    artifacts: new DirectoryReleaseArtifacts(values["release-dir"] ?? dirname(values.manifest)),
    secrets: envSecretSource(process.env),
    dryRun: command !== "apply",
    ...(values["registry-url"] ? { registry: httpRegistryEndpoint(values["registry-url"]) } : {}),
    onStep: (step) => console.log(`done     ${step.action.padEnd(7)} ${step.key}`),
  });
  printPreflight(report.preflight);
  if (command === "preflight" || !report.plan) return report.preflight.ok ? 0 : 1;

  for (const step of report.plan.steps) {
    if (step.action !== "noop" || command === "plan") console.log(`${step.action.padEnd(11)} ${step.key}  ${step.reason}`);
  }
  console.log("cost-relevant resources:");
  for (const line of report.plan.cost) {
    console.log(`  ${line.product}: ${line.total} (${line.creating} new), billed by ${line.billedBy}`);
  }
  if (report.status === "plan-blocked") {
    console.log("plan: blocked; nothing was changed");
    return 1;
  }
  if (report.registration) console.log(`fleet registration: ${report.registration.status}`);
  console.log(report.status === "applied" ? `applied release ${manifest.releaseId}` : "plan only; nothing was changed");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // SchoolOS errors carry safe messages; anything else is printed by name only, so a stray
    // exception can never echo the token or a secret.
    if (error instanceof InstallerHaltedError || error instanceof SchoolOsError) console.error(`${error.code}: ${error.message}`);
    else console.error(error instanceof Error ? `unexpected ${error.name}` : "unexpected error");
    process.exitCode = 1;
  },
);
