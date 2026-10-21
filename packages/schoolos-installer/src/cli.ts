// District-run installer CLI. The district runs it itself (or from its own CI) with an API token
// it created; the root's OAuth path uses the library directly.
//
//   pnpm --filter @schoolos/installer start <command> --config install.json --manifest release/manifest.json \
//     --signed-manifest release/manifest.signed.json
//
//   preflight   check the account, products, quotas, DNS and Access setup
//   plan        preflight, then observe and print the plan (changes nothing)
//   apply       preflight, plan and apply; then register with the root if --registry-url is given
//   rollback    return to a previous release:
//               --previous-manifest <file> --previous-signed-manifest <file>
//
// The manifest must come with the root's signed statement for it, verified against the release
// keys the config pins. A config with an `insecure-pin` release (development builds, which the
// release pipeline does not sign yet) is refused unless --insecure-pin is also given; its rollback
// then takes --previous-pin <releaseId>@<sha256> instead of a signed manifest.
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
import { loadPinnedManifest, type ReleaseManifest, verifyReleaseManifest } from "./manifest.ts";
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

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new SchoolOsError("validation-failed", `${path} is not readable JSON`);
  }
}

// The release a rollback returns to, verified the same way as the one being installed.
async function previousManifest(
  pin: DistrictInstallConfig["release"],
  values: { "previous-manifest"?: string; "previous-signed-manifest"?: string; "previous-pin"?: string },
): Promise<ReleaseManifest | undefined> {
  if (!values["previous-manifest"]) return undefined;
  const bytes = await readBytes(values["previous-manifest"]);
  if (pin.mode === "signed") {
    if (!values["previous-signed-manifest"]) return undefined;
    return (await verifyReleaseManifest(bytes, await readJson(values["previous-signed-manifest"]), pin.trust)).manifest;
  }
  const [releaseId, manifestSha256] = (values["previous-pin"] ?? "").split("@");
  if (!releaseId || !manifestSha256) return undefined;
  return await loadPinnedManifest(bytes, { ...pin, releaseId, manifestSha256 });
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      manifest: { type: "string" },
      "release-dir": { type: "string" },
      "registry-url": { type: "string" },
      "signed-manifest": { type: "string" },
      "previous-manifest": { type: "string" },
      "previous-signed-manifest": { type: "string" },
      "previous-pin": { type: "string" },
      "insecure-pin": { type: "boolean" },
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
  if (config.release.mode === "insecure-pin" && !values["insecure-pin"]) {
    console.error("the config pins the release by digest only (insecure-pin); pass --insecure-pin to accept an unsigned development release");
    return 2;
  }
  if (config.release.mode === "signed" && !values["signed-manifest"]) {
    console.error("--signed-manifest <file> is required: the root's signed statement for the release manifest");
    return 2;
  }
  const manifest = await loadPinnedManifest(
    await readBytes(values.manifest),
    config.release,
    values["signed-manifest"] ? { signedManifest: await readJson(values["signed-manifest"]) } : {},
  );
  const api = new CloudflareHttpApi({ tokens: districtRunTokenProvider(process.env) });

  if (command === "rollback") {
    const previous = await previousManifest(config.release, values);
    if (!previous) {
      console.error(config.release.mode === "signed"
        ? "rollback needs --previous-manifest <file> and --previous-signed-manifest <file>"
        : "rollback needs --previous-manifest <file> and --previous-pin <releaseId>@<sha256>");
      return 2;
    }
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
