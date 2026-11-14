// `launch-educate-os connect [<integration>]` and `launch-educate-os status`: what cli.ts calls.
// Both start from the answers file the install wrote, which says where the district is; neither
// needs the release.
import { EducateOsError } from "@educateos/contracts";
import { DISTRICT_TOKEN_ENV } from "@educateos/installer";
import { type Answers, installConfig, lastInstalled, readAnswers, writeAnswers } from "../answers.ts";
import type { LaunchCloudflare } from "../cloudflare.ts";
import type { Output } from "../output.ts";
import type { Prompter } from "../prompter.ts";
import { type ConnectContext, type ConnectFlags, districtTarget } from "./district.ts";
import { connectLti } from "./lti.ts";
import { connectOneRoster } from "./oneroster.ts";
import { type ConnectOutcome, integration, INTEGRATION_IDS, INTEGRATIONS, type IntegrationId } from "./outcome.ts";
import { connectClever, connectGoogleClassroom } from "./roster.ts";
import { districtStatus } from "./status.ts";

/** What the connect and status commands need from the CLI. */
export interface ConnectDeps {
  out: Output;
  prompter: Prompter | undefined;
  yes: boolean;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  answersPath: string;
  flags: ConnectFlags;
  /** The Cloudflare an install token reaches. */
  connect: (token: string) => LaunchCloudflare;
  /** The account already connected (after an install), so the token isn't asked again. */
  cf?: LaunchCloudflare;
  /** The release the account runs, when the caller knows it (else the answers' last install). */
  release?: string;
  /** Applies the answers file to the account with that release, so a connect never upgrades. */
  apply: (token: string, releaseId: string | undefined) => Promise<number>;
}

/** The connect context for the install the answers describe. */
async function contextFor(deps: ConnectDeps): Promise<{ context: ConnectContext; token: () => string | undefined }> {
  const answers = await readAnswers(deps.answersPath);
  if (answers === undefined) {
    throw new EducateOsError("not-found", `no answers file at ${deps.answersPath}: run this where you ran the install, or pass --config <file>`);
  }
  const config = installConfig(answers);
  const district = districtTarget(config);
  if (district === undefined) {
    throw new EducateOsError("validation-failed",
      "this install has no district LMS (the AI Workshop alone), so there is nothing to connect: run the install again and add the district LMS");
  }
  let token = deps.env[DISTRICT_TOKEN_ENV];
  let cf = deps.cf;
  const context: ConnectContext = {
    out: deps.out,
    prompter: deps.prompter,
    yes: deps.yes,
    config,
    district,
    answers,
    answersPath: deps.answersPath,
    fetch: deps.fetch,
    env: deps.env,
    flags: deps.flags,
    async cloudflare() {
      if (cf) return cf;
      if (!token && deps.prompter) {
        deps.out.line("Worker secrets are set with your Cloudflare API token (the install's, or one with Workers Scripts: Edit).");
        token = await deps.prompter.secret("Cloudflare API token");
      }
      if (!token) throw new EducateOsError("unauthenticated", `set ${DISTRICT_TOKEN_ENV} to a Cloudflare API token with Workers Scripts: Edit`);
      deps.out.secret(token);
      cf = deps.connect(token);
      return cf;
    },
  };
  return { context, token: () => token };
}

function printOutcome(out: Output, outcome: ConnectOutcome): void {
  out.event({ event: "connect", integration: outcome.integration, status: outcome.status, checks: outcome.checks, nextSteps: outcome.nextSteps });
  const name = integration(outcome.integration).name;
  const said: Record<ConnectOutcome["status"], string> = {
    connected: `${name} is connected.`,
    pending: `${name}: started; a step remains.`,
    failed: `${name}: a check failed, see above.`,
    skipped: `${name}: stopped, nothing more was changed.`,
    unsupported: `${name} isn't available yet.`,
  };
  out.line();
  out.line(said[outcome.status]);
  if (outcome.nextSteps.length > 0) {
    out.line("Next steps:");
    outcome.nextSteps.forEach((step, i) => out.line(`  ${i + 1}. ${step}`));
  }
}

/** Runs one integration's flow. */
export async function connectOne(context: ConnectContext, id: IntegrationId): Promise<ConnectOutcome> {
  const info = integration(id);
  const { out } = context;
  out.line();
  out.line(`Connect ${info.name}`);
  out.line("=".repeat(`Connect ${info.name}`.length));
  out.line(info.summary);
  out.line(`Evidence: ${info.evidence}`);
  out.line();
  switch (id) {
    case "canvas":
    case "moodle":
      return await connectLti(context, id);
    case "clever":
      return await connectClever(context);
    case "google-classroom":
      return await connectGoogleClassroom(context);
    case "oneroster":
      return await connectOneRoster(context);
    case "schoology":
    case "classlink":
      return { integration: id, status: "unsupported", checks: [], nextSteps: [] };
  }
}

const EXIT: Record<ConnectOutcome["status"], number> = { connected: 0, pending: 0, failed: 1, skipped: 1, unsupported: 1 };

/** `connect [<integration>]`: one integration, or the menu on a terminal. */
export async function connectCommand(deps: ConnectDeps, which: string | undefined): Promise<number> {
  if (which !== undefined && !(INTEGRATION_IDS as readonly string[]).includes(which)) {
    throw new EducateOsError("validation-failed", `unknown integration ${which}: choose one of ${INTEGRATION_IDS.join(", ")}`);
  }
  if (which === undefined && deps.prompter === undefined) {
    throw new EducateOsError("validation-failed", `no terminal for the menu: name the integration, e.g. \`connect canvas\` (${INTEGRATION_IDS.join(", ")})`);
  }
  const { context, token } = await contextFor(deps);
  const { out } = deps;
  out.line(`District: ${context.district.origin}`);
  const outcomes: ConnectOutcome[] = [];
  let next: IntegrationId | undefined = which as IntegrationId | undefined;
  for (;;) {
    if (next === undefined) {
      out.line();
      next = await deps.prompter!.select("What should the district connect?", INTEGRATIONS.map((entry) => ({
        label: `${entry.name.padEnd(17)} ${entry.kind.padEnd(7)}${entry.supported ? "" : "  (not available yet)"}`,
        value: entry.id,
      })));
    }
    const outcome = await connectOne(context, next);
    printOutcome(out, outcome);
    outcomes.push(outcome);
    if (outcome.answersChanged) {
      await writeAnswers(deps.answersPath, context.answers as Answers);
      out.line();
      out.line(`The district configuration changed in ${deps.answersPath}; the district Worker reads it once the install is applied.`);
      const apply = deps.yes || (deps.prompter !== undefined && await deps.prompter.confirm("Apply it to your account now?", true));
      if (apply) {
        const applyToken = token() ?? (deps.prompter ? await deps.prompter.secret("Cloudflare API token") : undefined);
        if (!applyToken) throw new EducateOsError("unauthenticated", `set ${DISTRICT_TOKEN_ENV} to apply the change`);
        deps.out.secret(applyToken);
        const code = await deps.apply(applyToken, deps.release ?? lastInstalled(context.answers)?.releaseId);
        if (code !== 0) return code;
      } else {
        out.line("Apply it later with `npx launch-educate-os` (it offers to reuse your answers).");
      }
    }
    if (which !== undefined || deps.prompter === undefined) break;
    if (!(await deps.prompter.confirm("Connect another integration?", false))) break;
    next = undefined;
  }
  out.line();
  out.line("Run `npx launch-educate-os status` any time to see what is connected and healthy.");
  return Math.max(...outcomes.map((outcome) => EXIT[outcome.status]));
}

const MARK: Record<string, string> = { ok: "ok  ", "not configured": "--  ", failing: "FAIL", unknown: "??  ", "not available": "n/a " };

/** `status`: every part of the district and each integration, with the fix for what isn't working. */
export async function statusCommand(deps: ConnectDeps): Promise<number> {
  const { context } = await contextFor(deps);
  const { out } = deps;
  out.line(`District ${context.district.origin} (Worker ${context.district.scriptName})`);
  const rows = await districtStatus(context, { cloudflare: deps.cf !== undefined || Boolean(deps.env[DISTRICT_TOKEN_ENV]) });
  out.event({ event: "status", rows });
  for (const row of rows) {
    out.line(`${MARK[row.state] ?? "??  "}  ${row.area.padEnd(16)} ${row.detail}`);
    if (row.fix && row.state !== "ok") out.line(`${" ".repeat(23)}fix: ${row.fix}`);
  }
  return rows.some((row) => row.state === "failing") ? 1 : 0;
}

/** After an install: offers the connect menu on a terminal, for a district install. */
export async function offerConnect(deps: ConnectDeps): Promise<void> {
  if (deps.prompter === undefined) return;
  const answers = await readAnswers(deps.answersPath);
  if (answers === undefined || districtTarget(installConfig(answers)) === undefined) return;
  deps.out.line();
  if (!(await deps.prompter.confirm("Connect your LMS and roster now?", true))) {
    deps.out.line("Later: `npx launch-educate-os connect`.");
    return;
  }
  await connectCommand(deps, undefined);
}

/** `doctor`'s integration section: the status report, when the answers name an installed district. */
export async function statusIfDistrict(deps: ConnectDeps): Promise<number> {
  const answers = await readAnswers(deps.answersPath).catch(() => undefined);
  if (answers === undefined || districtTarget(installConfig(answers)) === undefined) return 0;
  deps.out.line();
  deps.out.line("The district and its integrations (same as `status`):");
  return await statusCommand(deps);
}
