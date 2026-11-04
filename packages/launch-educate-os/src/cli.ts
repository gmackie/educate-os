// `npx launch-educate-os`: install EducateOS into your own Cloudflare account.
//
//   launch-educate-os [install]   the wizard (on a terminal), or --config <answers> non-interactively
//   launch-educate-os plan        preflight and plan only; changes nothing
//   launch-educate-os upgrade     install the newest release (or --release <id>) with saved answers
//   launch-educate-os rollback    return to the previous release (or --to <id>)
//   launch-educate-os doctor      check Node, the release source, the token and the account
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { EducateOsError } from "@educateos/contracts";
import { DISTRICT_TOKEN_ENV, type DistrictInstallConfig, httpRegistryEndpoint, install, staticTokenProvider } from "@educateos/installer";
import { ReleaseTrust } from "@educateos/releases";
import { readFile } from "node:fs/promises";
import { ANSWERS_FILE, ANSWERS_FORMAT, type Answers, type InstalledEntry, installConfig, lastInstalled, previousInstalled, readAnswers, writeAnswers } from "./answers.ts";
import { launchCloudflare, type LaunchCloudflare, TEST_CLOUDFLARE_RPC_ENV } from "./cloudflare.ts";
import { Output, type Writer } from "./output.ts";
import { type Prompter, PromptCancelled, type PromptStreams, streamPrompter } from "./prompter.ts";
import {
  checkReleaseOrder,
  type InstalledRelease,
  latestReleaseId,
  loadRelease,
  type ReleaseLocation,
  releaseBaseUrl,
  type VerifiedRelease,
} from "./release-source.ts";
import { deployedReleaseId, installRelease, LaunchSecrets, rollbackRelease, type RunContext } from "./run.ts";
import { DEFAULT_RELEASE_URL, EDUCATEOS_RELEASE_TRUST } from "./trust.ts";
import { runWizard } from "./wizard.ts";

declare const __LAUNCH_VERSION__: string | undefined;

/** The launcher's version, stamped in by the bundle. */
export const LAUNCH_VERSION = typeof __LAUNCH_VERSION__ === "string" ? __LAUNCH_VERSION__ : "0.0.0-source";

/** The Node versions the launcher runs on. */
export const MINIMUM_NODE = [22, 12] as const;

const COMMANDS = ["install", "plan", "upgrade", "rollback", "doctor", "help"] as const;
type Command = (typeof COMMANDS)[number];

/** Everything the CLI touches outside itself, so tests can run it in process. */
export interface CliIo {
  argv: string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  stdin: PromptStreams["input"];
  stdout: Writer & { isTTY?: boolean };
  stderr: Writer;
  /** Defaults to the global fetch. Used for the release mirror only. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export const USAGE = `launch-educate-os ${LAUNCH_VERSION}: install EducateOS into your own Cloudflare account

Usage:
  npx launch-educate-os [install]   guided install on a terminal (or --config <file> for CI)
  npx launch-educate-os plan        preflight and show the plan; change nothing
  npx launch-educate-os upgrade     install the newest signed release with your saved answers
  npx launch-educate-os rollback    go back to the previous release (--to <release-id>)
  npx launch-educate-os doctor      check Node, the release source, the token and the account

Options:
  --config <file>       answers file (default ./${ANSWERS_FILE}); written by the wizard, never holds secrets
  --yes                 apply without asking (needed without a terminal)
  --plan-only           stop after the plan (same as the plan command)
  --json                one JSON event per line on stdout, for CI; human text goes to stderr
  --release <id>        install this release instead of the newest
  --release-dir <dir>   read the release from a directory (offline; build-release.ts layout)
  --release-url <url>   read releases from this mirror (default ${DEFAULT_RELEASE_URL})
  --trust <file>        verify releases against these release keys (a ReleaseTrust JSON) instead of
                        the EducateOS keys built into this installer, e.g. for releases you sign
  --allow-downgrade     let install/upgrade move to an older release than the one installed
  --to <id>             rollback: the release to return to (default: the one before, from the answers)
  --current-release-dir <dir>  rollback offline: the installed release's directory
  --registry-url <url>  register with this registry after applying (needs "fleet" in the answers)
  -h, --help            this help
  -v, --version         the installer's version

Environment:
  ${DISTRICT_TOKEN_ENV}           the API token (otherwise the wizard asks for it, hidden)
  EDUCATEOS_SECRET_<PKG>__<NAME>  a gatekeeper or service secret, e.g. EDUCATEOS_SECRET_GATEKEEPER_GOOGLE__CLIENT_ID

Docs: https://educateos.io and docs/educateos/launch-installer.md in the EducateOS repository.`;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "plan-only": { type: "boolean" },
      json: { type: "boolean" },
      release: { type: "string" },
      "release-dir": { type: "string" },
      "release-url": { type: "string" },
      trust: { type: "string" },
      "allow-downgrade": { type: "boolean" },
      to: { type: "string" },
      "current-release-dir": { type: "string" },
      "registry-url": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

type Values = ReturnType<typeof parse>["values"];

async function readTrust(path: string | undefined, out: Output, cwd: string): Promise<ReleaseTrust> {
  if (path === undefined) return EDUCATEOS_RELEASE_TRUST;
  let json: unknown;
  try {
    json = JSON.parse(await readFile(resolve(cwd, path), "utf8"));
  } catch {
    throw new EducateOsError("validation-failed", `--trust ${path} is not readable JSON`);
  }
  const parsed = ReleaseTrust.safeParse(json);
  if (!parsed.success) throw new EducateOsError("validation-failed", `--trust ${path} is not a ReleaseTrust (root, keySetVersion, keys)`);
  out.line(`NOTE: verifying releases against the keys in ${path}, NOT the EducateOS release keys built into this installer.`);
  return parsed.data;
}

function location(values: Values, cwd: string): ReleaseLocation {
  if (values["release-dir"]) return { kind: "dir", path: resolve(cwd, values["release-dir"]) };
  return { kind: "url", base: releaseBaseUrl(values["release-url"] ?? DEFAULT_RELEASE_URL) };
}

function describeRelease(out: Output, release: VerifiedRelease, now: Date): void {
  const { statement } = release;
  out.event({
    event: "release", releaseId: release.releaseId, version: statement.version, channel: statement.channel,
    expiresAt: statement.expiresAt, source: release.source,
  });
  out.line(`Release ${release.releaseId}: EducateOS ${statement.version} (${statement.channel}), signed and verified against the pinned release keys.`);
  if (Date.parse(statement.expiresAt) <= now.getTime()) {
    out.line(`  Its signed statement expired ${statement.expiresAt}; it is still accepted within the 30-day grace for installs and rollbacks.`);
  }
  for (const migration of statement.migrations) {
    out.line(`  Includes ${migration.irreversible ? "an irreversible" : "a"} migration: ${migration.summary}`);
  }
}

/** The release the account runs now: its marker, with the version when this machine knows it. */
async function installedRelease(
  cf: LaunchCloudflare,
  config: DistrictInstallConfig,
  release: VerifiedRelease,
  answers: Answers | undefined,
  versionOf: (releaseId: string) => Promise<string | undefined>,
): Promise<InstalledRelease | undefined> {
  const deployed = await deployedReleaseId(cf, config, release.manifest);
  const last = lastInstalled(answers);
  const releaseId = deployed ?? last?.releaseId;
  if (releaseId === undefined) return undefined;
  const known = answers?.history.findLast((entry) => entry.releaseId === releaseId)?.version;
  const version = known ?? (releaseId === release.releaseId ? release.statement.version : await versionOf(releaseId));
  return { releaseId, ...(version === undefined ? {} : { version }) };
}

function tokenFromEnv(io: CliIo): string {
  const token = io.env[DISTRICT_TOKEN_ENV];
  if (!token) throw new EducateOsError("unauthenticated", `set ${DISTRICT_TOKEN_ENV} to a Cloudflare API token (see --help)`);
  return token;
}

function connect(io: CliIo, token: string): LaunchCloudflare {
  return launchCloudflare(io.env, staticTokenProvider("district-run", token));
}

/** The answers with `release` appended to their history, unless it is already the last entry (a re-run). */
function record(answers: Answers, release: VerifiedRelease, action: InstalledEntry["action"], now: Date): Answers {
  if (answers.history.at(-1)?.releaseId === release.releaseId) return answers;
  return { ...answers, history: [...answers.history, { releaseId: release.releaseId, version: release.statement.version, at: now.toISOString(), action }].slice(-100) };
}

/** Runs the CLI and resolves to its exit code. Never throws. */
export async function main(io: CliIo): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parse(io.argv));
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : "bad arguments"}\n\n${USAGE}\n`);
    return 2;
  }
  if (values.version) {
    io.stdout.write(`${LAUNCH_VERSION}\n`);
    return 0;
  }
  const command = (positionals[0] ?? "install") as Command;
  if (values.help || command === "help") {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!COMMANDS.includes(command) || positionals.length > 1) {
    io.stderr.write(`unknown command: ${positionals.join(" ")}\n\n${USAGE}\n`);
    return 2;
  }
  const out = new Output({ json: values.json === true, out: io.stdout, err: io.stderr });
  out.secret(io.env[DISTRICT_TOKEN_ENV]);
  const interactive = io.stdin.isTTY === true && io.stdout.isTTY === true && !values.json;
  const prompter = interactive ? streamPrompter({ input: io.stdin, output: io.stdout }) : undefined;
  try {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major! < MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor! < MINIMUM_NODE[1])) {
      throw new EducateOsError("validation-failed", `launch-educate-os needs Node ${MINIMUM_NODE.join(".")} or later; this is ${process.versions.node}`);
    }
    if (io.env[TEST_CLOUDFLARE_RPC_ENV]) out.line(`NOTE: ${TEST_CLOUDFLARE_RPC_ENV} is set: talking to a test Cloudflare, not api.cloudflare.com.`);
    if (command === "doctor") return await doctor(io, values, out);
    if (command === "rollback") return await rollbackCommand(io, values, out, prompter);
    return await installCommand(io, values, out, prompter, command);
  } catch (error) {
    if (error instanceof PromptCancelled) {
      out.line();
      out.line("Stopped. Nothing more was changed; run again to continue.");
      return 130;
    }
    out.error(error);
    return 1;
  } finally {
    prompter?.close();
  }
}

async function installCommand(io: CliIo, values: Values, out: Output, prompter: Prompter | undefined, command: "install" | "plan" | "upgrade"): Promise<number> {
  const now = io.now ?? (() => new Date());
  const fetchImpl = io.fetch ?? fetch.bind(globalThis);
  const answersPath = resolve(io.cwd, values.config ?? ANSWERS_FILE);
  const saved = await readAnswers(answersPath);
  if (values.config && saved === undefined) throw new EducateOsError("not-found", `no answers file at ${answersPath}`);
  if (command === "upgrade" && saved === undefined) {
    throw new EducateOsError("not-found", `upgrade needs the answers file from the install (${answersPath}); pass --config <file>`);
  }
  if (saved === undefined && prompter === undefined) {
    throw new EducateOsError("validation-failed", "no terminal to ask on: pass --config <answers file> (see --help), or run on a terminal");
  }

  const trust = await readTrust(values.trust, out, io.cwd);
  const where = location(values, io.cwd);
  out.line(where.kind === "url" ? `Fetching the ${values.release ? `release ${values.release}` : "newest release"} from ${where.base} ...` : `Reading the release in ${where.path} ...`);
  const release = await loadRelease({ location: where, ...(values.release ? { releaseId: values.release } : {}), trust, fetch: fetchImpl, now: now() });
  describeRelease(out, release, now());
  out.line();

  let answers: Answers;
  let cf: LaunchCloudflare;
  const useWizard = prompter !== undefined && command !== "upgrade" && values.config === undefined;
  if (useWizard) {
    const result = await runWizard({
      prompter, out, env: io.env, manifest: release.manifest, answersPath,
      connect: (token) => connect(io, token),
      ...(saved ? { saved } : {}),
    });
    cf = result.cf;
    answers = { format: ANSWERS_FORMAT, install: result.install, history: saved?.history ?? [] };
    await writeAnswers(answersPath, answers);
    out.line(`Answers saved to ${answersPath} (no token or secrets). Re-run to resume.`);
  } else {
    answers = saved!;
    const token = io.env[DISTRICT_TOKEN_ENV] ?? (prompter ? await prompter.secret("Cloudflare API token") : tokenFromEnv(io));
    out.secret(token);
    cf = connect(io, token);
  }

  const config = installConfig(answers, release.pin);
  const versionOf = async (releaseId: string) => {
    if (where.kind !== "url") return undefined;
    return (await loadRelease({ location: where, releaseId, trust, fetch: fetchImpl, now: now() }).catch(() => undefined))?.statement.version;
  };
  const installed = await installedRelease(cf, config, release, answers, versionOf);
  if (installed) out.line(`Installed now: ${installed.releaseId}${installed.version ? ` (${installed.version})` : ""}.`);
  checkReleaseOrder(installed, release.statement, values["allow-downgrade"] === true);

  const context: RunContext = { out, cf, prompter, yes: values.yes === true, secrets: new LaunchSecrets(io.env, out) };
  const outcome = await installRelease(context, {
    config,
    release,
    planOnly: command === "plan" || values["plan-only"] === true,
    ...(values["registry-url"] ? { registry: httpRegistryEndpoint(values["registry-url"]) } : {}),
  });
  if (outcome.applied) {
    const action = installed === undefined ? "install" : installed.releaseId === release.releaseId ? "install" : "upgrade";
    await writeAnswers(answersPath, record(answers, release, action, now()));
  }
  return outcome.exitCode;
}

async function rollbackCommand(io: CliIo, values: Values, out: Output, prompter: Prompter | undefined): Promise<number> {
  const now = io.now ?? (() => new Date());
  const fetchImpl = io.fetch ?? fetch.bind(globalThis);
  const answersPath = resolve(io.cwd, values.config ?? ANSWERS_FILE);
  const answers = await readAnswers(answersPath);
  if (answers === undefined) throw new EducateOsError("not-found", `rollback needs the answers file from the install (${answersPath}); pass --config <file>`);
  const trust = await readTrust(values.trust, out, io.cwd);
  const token = io.env[DISTRICT_TOKEN_ENV] ?? (prompter ? await prompter.secret("Cloudflare API token") : tokenFromEnv(io));
  out.secret(token);
  const cf = connect(io, token);

  const targetId = values.to ?? previousInstalled(answers)?.releaseId;
  if (targetId === undefined) throw new EducateOsError("validation-failed", "there is no earlier release in the answers file: pass --to <release-id>");
  const where = location(values, io.cwd);
  const previous = await loadRelease({ location: where, releaseId: targetId, trust, fetch: fetchImpl, now: now() });
  describeRelease(out, previous, now());

  // The release installed now: the account's marker, else the answers' last entry.
  const probeConfig = installConfig(answers, previous.pin);
  const currentId = (await deployedReleaseId(cf, probeConfig, previous.manifest)) ?? lastInstalled(answers)?.releaseId;
  if (currentId === undefined) throw new EducateOsError("not-found", "EducateOS doesn't look installed in this account: nothing to roll back");
  if (currentId === previous.releaseId) {
    out.line(`${previous.releaseId} is already the installed release.`);
    return 0;
  }
  const currentWhere: ReleaseLocation = values["current-release-dir"] ? { kind: "dir", path: resolve(io.cwd, values["current-release-dir"]) } : where;
  if (currentWhere.kind === "dir" && currentWhere === where) {
    throw new EducateOsError("validation-failed", "an offline rollback needs the installed release too: pass --current-release-dir <dir>");
  }
  const current = await loadRelease({ location: currentWhere, releaseId: currentId, trust, fetch: fetchImpl, now: now() });
  out.line(`Installed now: ${current.releaseId} (${current.statement.version}).`);

  const context: RunContext = { out, cf, prompter, yes: values.yes === true, secrets: new LaunchSecrets(io.env, out) };
  const outcome = await rollbackRelease(context, {
    config: installConfig(answers, current.pin),
    current,
    previous,
    planOnly: values["plan-only"] === true,
  });
  if (outcome.applied) await writeAnswers(answersPath, record(answers, previous, "rollback", now()));
  return outcome.exitCode;
}

async function doctor(io: CliIo, values: Values, out: Output): Promise<number> {
  const now = io.now ?? (() => new Date());
  const fetchImpl = io.fetch ?? fetch.bind(globalThis);
  let failed = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failed++;
    out.event({ event: "doctor", check: name, ok, detail });
    out.line(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(10)} ${detail}`);
  };
  const skip = (name: string, detail: string) => {
    out.event({ event: "doctor", check: name, ok: true, detail: `skipped: ${detail}` });
    out.line(`--    ${name.padEnd(10)} ${detail}`);
  };
  check("node", true, `Node ${process.versions.node} (needs ${MINIMUM_NODE.join(".")}+)`);

  let release: VerifiedRelease | undefined;
  try {
    const trust = await readTrust(values.trust, out, io.cwd);
    const where = location(values, io.cwd);
    const releaseId = values.release ?? (where.kind === "url" ? await latestReleaseId(where.base, fetchImpl) : undefined);
    release = await loadRelease({ location: where, ...(releaseId ? { releaseId } : {}), trust, fetch: fetchImpl, now: now() });
    check("release", true, `${release.releaseId} (${release.statement.version}, ${release.statement.channel}) verifies; statement expires ${release.statement.expiresAt}`);
  } catch (error) {
    check("release", false, error instanceof EducateOsError ? error.message : "could not be loaded");
  }

  const answersPath = resolve(io.cwd, values.config ?? ANSWERS_FILE);
  let loaded: Answers | undefined;
  try {
    loaded = await readAnswers(answersPath);
    if (loaded) check("answers", true, `${answersPath} is valid (${loaded.history.length} release(s) installed from here)`);
    else skip("answers", `no ${answersPath} yet`);
  } catch (error) {
    check("answers", false, error instanceof EducateOsError ? error.message : "unreadable");
  }
  const answers = loaded;

  const token = io.env[DISTRICT_TOKEN_ENV];
  if (!token) {
    skip("token", `${DISTRICT_TOKEN_ENV} is not set: account checks skipped`);
    return failed === 0 ? 0 : 1;
  }
  const cf = connect(io, token);
  try {
    const accounts = await cf.listAccounts();
    check("token", accounts.length > 0, `the token can see ${accounts.length} account(s)`);
    if (answers) {
      const accountId = String(answers.install.accountId);
      const visible = accounts.some((a) => a.id === accountId);
      check("account", visible, `account ${accountId} ${visible ? "is" : "is NOT"} visible to the token`);
    }
  } catch (error) {
    check("token", false, error instanceof EducateOsError ? error.message : "Cloudflare refused it");
    return 1;
  }
  if (answers && release) {
    const config = installConfig(answers, release.pin);
    const deployed = await deployedReleaseId(cf, config, release.manifest);
    if (deployed) check("installed", true, `the account runs ${deployed}${deployed === release.releaseId ? " (up to date)" : `; ${release.releaseId} is available`}`);
    else skip("installed", "EducateOS isn't installed in the account yet");
    const report = await install({
      api: cf.api, config, manifest: release.manifest, artifacts: release.artifacts, secrets: new LaunchSecrets(io.env, out), dryRun: true,
    });
    check("preflight", report.preflight.ok, report.preflight.ok
      ? `ready${report.preflight.warnings.length ? ` (${report.preflight.warnings.length} warning(s))` : ""}`
      : report.preflight.blocking.map((item) => item.code).join(", "));
    for (const item of [...report.preflight.blocking, ...report.preflight.warnings]) {
      out.line(`        ${item.message}${item.operatorAction ? ` ${item.operatorAction}` : ""}`);
    }
  }
  return failed === 0 ? 0 : 1;
}
