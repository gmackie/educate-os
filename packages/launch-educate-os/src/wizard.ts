// The interactive install: what it will do and cost, the Cloudflare token, the account, the
// hostname, Zero Trust and who may sign in. Every answer but the token is saved (answers.ts), so a
// re-run offers to reuse them and goes straight to preflight.
import { readFile } from "node:fs/promises";
import { EducateOsError } from "@educateos/contracts";
import {
  CloudflareApiError,
  DISTRICT_TOKEN_ENV,
  DistrictSlug,
  INSTALL_TOKEN_PERMISSIONS,
  installTokenLink,
  MANAGED_ZONE,
  MAX_INSTANCE_SLUG_LENGTH,
  type ReleaseManifest,
} from "@educateos/installer";
import { z } from "zod";
import { type Answers, installConfig } from "./answers.ts";
import type { AccountSummary, LaunchCloudflare } from "./cloudflare.ts";
import type { Output } from "./output.ts";
import type { Prompter } from "./prompter.ts";
import { districtPackage, installUrls } from "./run.ts";

/** What the wizard needs. */
export interface WizardDeps {
  prompter: Prompter;
  out: Output;
  env: Readonly<Record<string, string | undefined>>;
  /** The Cloudflare a token reaches. */
  connect: (token: string) => LaunchCloudflare;
  /** The release being installed, so the wizard offers only what it ships. */
  manifest: ReleaseManifest;
  /** Answers saved by an earlier run, if any. */
  saved?: Answers;
  /** Where the answers are saved, for the operator. */
  answersPath: string;
}

/** What the wizard ends with. The token is returned to the caller only, never saved. */
export interface WizardResult {
  install: Record<string, unknown>;
  token: string;
  cf: LaunchCloudflare;
  /** Whether these are saved answers reused as they were. */
  reused: boolean;
}

const TOKEN = /^[A-Za-z0-9_-]{30,200}$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SLUG = new RegExp(`^[a-z0-9][a-z0-9-]{0,${MAX_INSTANCE_SLUG_LENGTH - 1}}$`);

function list(value: string): string[] {
  return value.split(/[\s,]+/).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "");
}

const isEmail = (value: string) => z.email().safeParse(value).success;

function welcome(out: Output): void {
  out.line("EducateOS installer");
  out.line("===================");
  out.line("This installs EducateOS (the district-owned K-12 LMS and AI Workshop) into YOUR Cloudflare");
  out.line("account. It runs there, under your control, whether or not educateos.io is up.");
  out.line();
  out.line("What it does:");
  out.line("  1. Asks for a Cloudflare API token, your account, a hostname and who may sign in.");
  out.line("  2. Checks the account (read-only) and shows exactly what it will create or change.");
  out.line("  3. Only after you confirm, creates the Workers, storage and Access apps, then prints your URLs.");
  out.line();
  out.line("What it needs and costs (billed to you by Cloudflare, not by EducateOS):");
  out.line("  - Workers Paid, from $5/month: EducateOS uses Durable Objects, Cron Triggers and Worker Loader.");
  out.line("  - R2 enabled (it needs a payment method; light use stays in the free tier). KV, D1 and Durable");
  out.line("    Objects usage is billed under Workers Paid; AI Gateway's core features are free.");
  out.line("  - A domain on Cloudflare (an active zone in the account) for the EducateOS hostname.");
  out.line("  - Cloudflare Zero Trust with your district's sign-in (SAML or OIDC). Zero Trust Free covers 50");
  out.line("    users; every student and teacher who signs in takes a seat, so most districts need paid seats.");
  out.line("  - Workers AI usage for the AI Workshop, billed per use.");
  out.line();
  out.line("Nothing is changed until you confirm the plan. Re-running continues where a run stopped.");
  out.line();
}

async function askToken(deps: WizardDeps): Promise<{ token: string; cf: LaunchCloudflare; accounts: AccountSummary[] }> {
  const fromEnv = deps.env[DISTRICT_TOKEN_ENV];
  if (!fromEnv) {
    deps.out.line("Cloudflare API token");
    deps.out.line("--------------------");
    deps.out.line("Create a token with exactly these permissions (the link prefills them), scoped to the account");
    deps.out.line("and zone you install into, with a short expiry. Delete it once the install finishes.");
    deps.out.line(`  ${installTokenLink("EducateOS install (launch-educate-os)")}`);
    for (const p of INSTALL_TOKEN_PERMISSIONS) deps.out.line(`    ${p.scope}: ${p.name}: ${p.level}`);
    deps.out.line(`(Or set ${DISTRICT_TOKEN_ENV} before running. The token is never saved or printed.)`);
  }
  for (let attempt = 1; ; attempt++) {
    const token = fromEnv ?? await deps.prompter.secret("Paste the API token");
    if (!TOKEN.test(token)) {
      if (fromEnv || attempt >= 3) throw new EducateOsError("validation-failed", "that doesn't look like a Cloudflare API token");
      deps.out.line("  That doesn't look like a Cloudflare API token. Try again.");
      continue;
    }
    deps.out.secret(token);
    const cf = deps.connect(token);
    try {
      const accounts = await cf.listAccounts();
      deps.out.line(fromEnv ? `Using the token in ${DISTRICT_TOKEN_ENV}: it can see ${accounts.length} account(s).` : `Token accepted: it can see ${accounts.length} account(s).`);
      return { token, cf, accounts };
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || (error.code !== "unauthenticated" && error.code !== "forbidden")) throw error;
      const why = error.code === "unauthenticated"
        ? "Cloudflare refused the token (wrong, expired or deleted)."
        : "The token can't list accounts: give it Account Settings: Read.";
      if (fromEnv || attempt >= 3) throw new EducateOsError(error.code, why);
      deps.out.line(`  ${why} Try again.`);
    }
  }
}

function summary(install: Record<string, unknown>, deps: WizardDeps): string[] {
  const config = installConfig({ install });
  const urls = installUrls(config, deps.manifest);
  return [
    `  account        ${config.accountId}`,
    `  instance       ${config.instanceId}`,
    ...Object.entries(urls).map(([kind, url]) => `  ${kind.padEnd(14)} ${url}`),
    `  Zero Trust     ${config.access.teamName}.cloudflareaccess.com`,
    `  may sign in    ${[...config.access.allowedEmailDomains.map((d) => `@${d}`), ...config.access.allowedEmails].join(", ")}`,
    `  administrators ${config.admins.join(", ")}`,
  ];
}

/** Runs the wizard. Throws {@link PromptCancelled} if the operator stops it. */
export async function runWizard(deps: WizardDeps): Promise<WizardResult> {
  const { prompter, out } = deps;
  welcome(out);
  const { token, cf, accounts } = await askToken(deps);
  if (accounts.length === 0) throw new EducateOsError("forbidden", "the token can't see any Cloudflare account: scope it to the account to install into");

  if (deps.saved) {
    out.line();
    out.line(`Saved answers in ${deps.answersPath}:`);
    for (const line of summary(deps.saved.install, deps)) out.line(line);
    const savedAccount = String(deps.saved.install.accountId ?? "");
    if (!accounts.some((account) => account.id === savedAccount)) {
      out.line(`  This token can't see account ${savedAccount}, so the answers can't be reused with it.`);
    } else if (await prompter.confirm("Reuse these answers?", true)) {
      return { install: deps.saved.install, token, cf, reused: true };
    }
  }

  // The account.
  out.line();
  const account = accounts.length === 1
    ? accounts[0]!
    : await prompter.select("Which account should EducateOS be installed into?", accounts.map((a) => ({ label: `${a.name} (${a.id})`, value: a })));
  out.line(`Account: ${account.name} (${account.id})`);

  // The hostname.
  const zones = await cf.listZones(account.id);
  const active = zones.filter((zone) => zone.status === "active");
  const managedInAccount = active.some((zone) => zone.name === MANAGED_ZONE);
  const own = active.filter((zone) => zone.name !== MANAGED_ZONE && !zone.name.endsWith(`.${MANAGED_ZONE}`));
  for (const zone of zones.filter((z) => z.status !== "active")) {
    out.line(`  (${zone.name} is ${zone.status}: finish delegating its nameservers to use it.)`);
  }
  type Where = { kind: "zone"; zone: string } | { kind: "managed-only" };
  const choices: { label: string; value: Where }[] = own.map((zone) => ({ label: `a hostname under ${zone.name}`, value: { kind: "zone", zone: zone.name } }));
  if (managedInAccount) choices.push({ label: `only <name>.${MANAGED_ZONE} (this account holds ${MANAGED_ZONE})`, value: { kind: "managed-only" } });
  if (choices.length === 0) {
    throw new EducateOsError("not-found",
      "this account has no active zone. Add your domain in the Cloudflare dashboard (Websites, Add a domain), delegate its nameservers, and run again");
  }
  out.line();
  const where = choices.length === 1 ? choices[0]!.value : await prompter.select("Where should EducateOS be served?", choices);
  let baseDomain: string | undefined;
  let subdomain: string | undefined;
  if (where.kind === "zone") {
    baseDomain = where.zone;
    subdomain = await prompter.text(`Subdomain of ${baseDomain} for EducateOS`, {
      default: "educateos",
      validate: (value) => (DNS_LABEL.test(value) ? undefined : "Use lowercase letters, digits and hyphens."),
    });
    out.line(`Hostname: ${subdomain}.${baseDomain}`);
  }

  // The instance's short name, which every resource name carries.
  const suggested = (baseDomain?.split(".")[0] ?? "").replace(/[^a-z0-9-]/g, "").slice(0, MAX_INSTANCE_SLUG_LENGTH).replace(/-+$/, "");
  const managed = where.kind === "managed-only";
  const slug = await prompter.text(managed
    ? `Name for <name>.${MANAGED_ZONE} (also names every resource it creates)`
    : "Short name for this installation (names every resource it creates, e.g. educateos-<name>-router)", {
    ...(suggested ? { default: suggested } : {}),
    validate: (value) => {
      if (!SLUG.test(value)) return `Use up to ${MAX_INSTANCE_SLUG_LENGTH} lowercase letters, digits and hyphens.`;
      if (managed && !DistrictSlug.safeParse(value).success) return "That name is reserved or not a valid address label.";
      return undefined;
    },
  });
  let managedHostname: { slug: string } | undefined = managed ? { slug } : undefined;
  if (!managed && managedInAccount && DistrictSlug.safeParse(slug).success) {
    if (await prompter.confirm(`Also serve it at ${slug}.${MANAGED_ZONE}?`, false)) managedHostname = { slug };
  } else if (!managed) {
    out.line(`(A managed ${slug}.${MANAGED_ZONE} address needs educateos.io to publish DNS records for it, which only the`);
    out.line(` guided install at https://${MANAGED_ZONE}/app/install arranges today. You can add one later.)`);
  }

  // Zero Trust.
  out.line();
  let teamName: string | undefined;
  try {
    const organization = await cf.api.getAccessOrganization(account.id);
    teamName = organization?.authDomain.replace(/\.cloudflareaccess\.com$/, "");
  } catch {
    teamName = undefined;
  }
  if (teamName) out.line(`Zero Trust team: ${teamName} (found in the account). Students and staff sign in through it.`);
  else {
    out.line("This account has no Zero Trust team yet. Create one at https://one.dash.cloudflare.com/ and add your");
    out.line("district's identity provider (SAML or OIDC); preflight stops until both exist.");
    teamName = await prompter.text("Zero Trust team name (<team>.cloudflareaccess.com)", {
      validate: (value) => (DNS_LABEL.test(value) ? undefined : "Use lowercase letters, digits and hyphens."),
    });
  }

  // Who may sign in.
  const allowedEmailDomains = list(await prompter.text("Email domains whose people may sign in (comma-separated, blank for none)", {
    ...(baseDomain ? { default: baseDomain } : {}),
    validate: (value) => (list(value).every((d) => DOMAIN.test(d)) ? undefined : "Enter domain names such as district.example."),
  }));
  const allowedEmails = list(await prompter.text("Individual email addresses that may also sign in (comma-separated, optional)", {
    validate: (value) => {
      if (!list(value).every(isEmail)) return "Enter email addresses.";
      if (allowedEmailDomains.length === 0 && list(value).length === 0) return "Admit at least one email domain or address.";
      return undefined;
    },
  }));
  const admins = list(await prompter.text("Administrator email addresses (comma-separated)", {
    validate: (value) => (list(value).length > 0 && list(value).every(isEmail) ? undefined : "Enter at least one email address."),
  }));

  // The district LMS, at the root of the hostname with the Workshop at /ai (ADR-0014).
  const install: Record<string, unknown> = {
    instanceId: `ins_${slug}`,
    accountId: account.id,
    ...(baseDomain ? { baseDomain, subdomain } : {}),
    ...(managedHostname ? { managedHostname } : {}),
    access: { teamName, allowedEmailDomains, allowedEmails },
    admins,
  };
  const district = districtPackage(deps.manifest);
  out.line();
  if (district !== undefined) {
    out.line("The district LMS serves your district at the root of the hostname, with the AI Workshop at /ai. It");
    out.line("starts from a district configuration (DISTRICT_CONFIG): your district, its trusted issuers and the");
    out.line("administrators who will import the roster (see packages/educateos-district-worker/README.md).");
    out.line("Without it, this installs the AI Workshop alone; you can add the LMS on a later run.");
    if (await prompter.confirm("Install the district LMS too?", false)) {
      const text = await readDistrictConfig(prompter);
      install.services = { [district]: { enabled: true, vars: { DISTRICT_CONFIG: text } } };
      const hasAdmin = Object.values(deps.manifest.workers).some((worker) => worker.kind === "admin");
      if (hasAdmin && baseDomain && await prompter.confirm(`Also install the open-source admin at admin.${baseDomain}?`, false)) {
        install.admin = { enabled: true };
      }
    }
  }
  install.aiGateway = await prompter.confirm("Create an AI Gateway for the Workshop's AI usage (logs, caching, rate limits)?", true);

  out.line();
  out.line("Registering this installation with educateos.io is optional and off. educateos.io's registry");
  out.line("accepts registrations only from its guided install today, so this installer never contacts it.");

  installConfig({ install });
  out.line();
  out.line("Summary:");
  for (const line of summary(install, deps)) out.line(line);
  return { install, token, cf, reused: false };
}

async function readDistrictConfig(prompter: Prompter): Promise<string> {
  for (;;) {
    const path = await prompter.text("Path to the district configuration JSON file");
    let json: unknown;
    try {
      json = JSON.parse(await readFile(path, "utf8"));
    } catch {
      json = undefined;
    }
    if (typeof json === "object" && json !== null && !Array.isArray(json)) return JSON.stringify(json);
    if (!(await prompter.confirm("That file isn't readable as a JSON object. Try another path?", true))) {
      throw new EducateOsError("validation-failed", "no district configuration was given");
    }
  }
}
