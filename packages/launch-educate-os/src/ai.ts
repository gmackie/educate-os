// `launch-educate-os ai`: turn Anthropic or OpenAI on for a district with a key pasted once
// (SCHO-446). The key is checked against the provider through the district's own AI Gateway, then
// stored in that gateway (Cloudflare keeps it in the account's Secrets Store), and the provider is
// added to the install's `ai.providers`, so the backend's CF_AI_GATEWAY_PROVIDERS lists it once the
// answers are applied. The key is never written to the answers file, a Worker var, or any output.
//
//   ai status                 which providers are on, and which keys the gateway holds
//   ai add <provider>         check and store a key, then turn the provider on
//   ai remove <provider>      turn the provider off (the stored key stays until deleted)
import { EducateOsError } from "@educateos/contracts";
import {
  CloudflareApiError,
  DISTRICT_TOKEN_ENV,
  FRONTIER_PROVIDERS,
  type FrontierProvider,
  resourcePrefix,
} from "@educateos/installer";
import { type Answers, installConfig, lastInstalled, readAnswers, writeAnswers } from "./answers.ts";
import type { LaunchCloudflare } from "./cloudflare.ts";
import type { Output } from "./output.ts";
import type { Prompter } from "./prompter.ts";

/** What `ai` needs. */
export interface AiDeps {
  out: Output;
  prompter: Prompter | undefined;
  yes: boolean;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  answersPath: string;
  connect: (token: string) => LaunchCloudflare;
  /** Applies the answers file with the release the account runs, so this never upgrades. */
  apply: (token: string, releaseId: string | undefined) => Promise<number>;
}

/** The `ai` usage lines, for the launcher's help. */
export const AI_USAGE = `  npx launch-educate-os ai status            which AI providers are on, and the keys your gateway holds
  npx launch-educate-os ai add <provider>     paste an Anthropic or OpenAI API key once: checked, stored in
                                              your AI Gateway, and the provider turned on (anthropic, openai)
  npx launch-educate-os ai remove <provider>  turn a provider off`;

const NAMES: Record<FrontierProvider, string> = { anthropic: "Anthropic", openai: "OpenAI" };

/** The environment variable a non-interactive `ai add` reads the key from. */
export const providerKeyEnv = (provider: FrontierProvider) => `EDUCATEOS_${provider.toUpperCase()}_API_KEY`;

// What each provider's keys look like, so an obvious paste mistake is caught before any request.
const KEY_SHAPE: Record<FrontierProvider, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,300}$/,
  openai: /^sk-[A-Za-z0-9_-]{20,300}$/,
};

/** The gateway request that checks a key: listing models, which runs no model and costs nothing. */
function keyCheck(provider: FrontierProvider, accountId: string, gatewayId: string, key: string): { url: string; headers: Record<string, string> } {
  const base = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}`;
  return provider === "anthropic"
    ? { url: `${base}/anthropic/v1/models`, headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }
    : { url: `${base}/openai/models`, headers: { authorization: `Bearer ${key}` } };
}

/** Where an administrator replaces or deletes a stored key. */
const gatewayDashboard = (accountId: string, gatewayId: string) =>
  `https://dash.cloudflare.com/${accountId}/ai/ai-gateway/gateways/${gatewayId}`;

function parseProvider(value: string | undefined): FrontierProvider {
  if (value === undefined || !(FRONTIER_PROVIDERS as readonly string[]).includes(value)) {
    throw new EducateOsError("validation-failed", `name the provider: ${FRONTIER_PROVIDERS.join(" or ")}`);
  }
  return value as FrontierProvider;
}

async function load(deps: AiDeps) {
  const answers = await readAnswers(deps.answersPath);
  if (answers === undefined) {
    throw new EducateOsError("not-found", `no answers file at ${deps.answersPath}: run this where you ran the install, or pass --config <file>`);
  }
  const config = installConfig(answers);
  if (!config.aiGateway) {
    throw new EducateOsError("validation-failed",
      "this install has no AI Gateway, so there is nowhere to keep a provider key: run the install again and turn AI on");
  }
  return { answers, config, gatewayId: resourcePrefix(config) };
}

async function token(deps: AiDeps, why: string): Promise<string> {
  let value = deps.env[DISTRICT_TOKEN_ENV];
  if (!value && deps.prompter) {
    deps.out.line(why);
    value = await deps.prompter.secret("Cloudflare API token");
  }
  if (!value) throw new EducateOsError("unauthenticated", `set ${DISTRICT_TOKEN_ENV} to a Cloudflare API token: ${why}`);
  deps.out.secret(value);
  return value;
}

function providersOf(answers: Answers): FrontierProvider[] {
  const ai = answers.install.ai as { providers?: FrontierProvider[] } | undefined;
  return [...ai?.providers ?? []];
}

function setProviders(answers: Answers, providers: FrontierProvider[]): void {
  const ai = (answers.install.ai ?? { enabled: true }) as Record<string, unknown>;
  answers.install.ai = { ...ai, providers };
}

/** Saves the changed answers and applies them, or says how to later. */
async function applyChange(deps: AiDeps, answers: Answers, cloudflareToken: string): Promise<number> {
  await writeAnswers(deps.answersPath, answers);
  const apply = deps.yes || (deps.prompter !== undefined && await deps.prompter.confirm("Apply it to your account now?", true));
  if (!apply) {
    deps.out.line("Saved. Apply it later with `npx launch-educate-os` (it offers to reuse your answers).");
    return 0;
  }
  return await deps.apply(cloudflareToken, lastInstalled(answers)?.releaseId);
}

async function add(deps: AiDeps, provider: FrontierProvider): Promise<number> {
  const { out, prompter } = deps;
  const { answers, config, gatewayId } = await load(deps);
  const name = NAMES[provider];
  out.line(`Add ${name} to the AI Workshop`);
  out.line("=".repeat(`Add ${name} to the AI Workshop`.length));
  out.line(`The key is checked with ${name}, then kept in your AI Gateway (${gatewayId}) in your own Cloudflare account.`);
  out.line("It is never saved in the answers file, a Worker setting, or anywhere EducateOS can read it.");
  out.line(`Turning ${name} on sends what staff and students type in the AI Workshop to ${name}, under your agreement`);
  out.line(`with ${name}. Workers AI keeps running in your account as before.`);
  if (!deps.yes && !(prompter && await prompter.confirm(`Turn ${name} on for your district?`, false))) {
    out.line("Nothing was changed.");
    return 1;
  }

  const cloudflareToken = await token(deps,
    "Storing the key needs a Cloudflare API token with AI Gateway: Edit, Secrets Store: Edit and Workers Scripts: Edit.");
  const cf = deps.connect(cloudflareToken);
  const stored = (await cf.api.listAiGatewayProviderKeys(config.accountId, gatewayId).catch(translate))
    .find((key) => key.providerSlug === provider && key.alias === "default");

  if (stored !== undefined) {
    out.line(`Your gateway already holds a ${name} key (${stored.secretPreview ?? "hidden"}). Replace or delete it at`);
    out.line(`  ${gatewayDashboard(config.accountId, gatewayId)} (Provider Keys).`);
  } else {
    const key = (deps.env[providerKeyEnv(provider)] ?? (prompter ? await prompter.secret(`Paste the ${name} API key`) : "")).trim();
    if (key === "") throw new EducateOsError("validation-failed", `no key: paste it on a terminal, or set ${providerKeyEnv(provider)}`);
    out.secret(key);
    if (!KEY_SHAPE[provider].test(key)) {
      throw new EducateOsError("validation-failed", `that doesn't look like a ${name} API key (${provider === "anthropic" ? "sk-ant-…" : "sk-…"})`);
    }
    await checkKey(deps, provider, config.accountId, gatewayId, key);
    // Cloudflare keeps the key in a Secrets Store the gateway names; the installer creates the
    // gateway without one, so the first key attaches it.
    const store = await cf.api.attachAiGatewayStore(config.accountId, gatewayId).catch(translate);
    if (store.storeCreated) out.line("Created your account's Secrets Store, where Cloudflare keeps the key.");
    await cf.api.storeAiGatewayProviderKey(config.accountId, gatewayId, provider, key).catch(translate);
    out.line(`Stored the ${name} key in your AI Gateway.`);
  }

  const providers = providersOf(answers);
  if (providers.includes(provider)) {
    out.line(`${name} is already on. Nothing else to change.`);
    return 0;
  }
  setProviders(answers, [...providers, provider]);
  out.line(`${name} turns on for the AI Workshop once the install is applied; staff then pick its models in a chat.`);
  return await applyChange(deps, answers, cloudflareToken);
}

/** Asks the provider, through the district's gateway, whether the key works. */
async function checkKey(deps: AiDeps, provider: FrontierProvider, accountId: string, gatewayId: string, key: string): Promise<void> {
  const name = NAMES[provider];
  const { url, headers } = keyCheck(provider, accountId, gatewayId, key);
  let response: Response;
  try {
    response = await deps.fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new EducateOsError("unavailable", `couldn't reach your AI Gateway to check the key; nothing was stored. Try again`);
  }
  // Never read or print the body: a provider's error may echo part of the key.
  await response.body?.cancel();
  if (response.ok) {
    deps.out.line(`${name} accepted the key.`);
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new EducateOsError("unauthenticated", `${name} rejected that key; nothing was stored. Check it was copied whole and is active`);
  }
  if (response.status === 429) {
    throw new EducateOsError("unavailable", `${name} is rate-limiting this key right now; nothing was stored. Try again in a minute`);
  }
  throw new EducateOsError("unavailable", `couldn't check the key: ${name} answered HTTP ${response.status} through your gateway; nothing was stored`);
}

async function remove(deps: AiDeps, provider: FrontierProvider): Promise<number> {
  const { answers, config, gatewayId } = await load(deps);
  const name = NAMES[provider];
  const providers = providersOf(answers);
  if (!providers.includes(provider)) {
    deps.out.line(`${name} is already off.`);
    return 0;
  }
  setProviders(answers, providers.filter((p) => p !== provider));
  deps.out.line(`${name} turns off for the AI Workshop once the install is applied.`);
  deps.out.line(`The key stays in your AI Gateway; delete it at ${gatewayDashboard(config.accountId, gatewayId)} (Provider Keys).`);
  const cloudflareToken = await token(deps, "Applying the change needs a Cloudflare API token with Workers Scripts: Edit.");
  return await applyChange(deps, answers, cloudflareToken);
}

async function status(deps: AiDeps): Promise<number> {
  const { out } = deps;
  const { answers, config, gatewayId } = await load(deps);
  const on = providersOf(answers);
  out.line(`AI Gateway: ${gatewayId}`);
  out.line("  Workers AI   on (runs in your account; no key)");
  let keys: { providerSlug: string; secretPreview: string | undefined }[] | undefined;
  if (deps.env[DISTRICT_TOKEN_ENV]) {
    out.secret(deps.env[DISTRICT_TOKEN_ENV]);
    keys = await deps.connect(deps.env[DISTRICT_TOKEN_ENV]!).api.listAiGatewayProviderKeys(config.accountId, gatewayId).catch(translate);
  }
  for (const provider of FRONTIER_PROVIDERS) {
    const key = keys?.find((k) => k.providerSlug === provider);
    const stored = keys === undefined ? `set ${DISTRICT_TOKEN_ENV} to see its key` : key ? `key ${key.secretPreview ?? "stored"}` : "no key stored";
    out.line(`  ${NAMES[provider].padEnd(12)} ${on.includes(provider) ? "on " : "off"} (${stored})`);
  }
  out.line("Add one with `npx launch-educate-os ai add anthropic` or `ai add openai`.");
  return 0;
}

/** Cloudflare's refusals in an administrator's words. */
function translate(error: unknown): never {
  if (error instanceof CloudflareApiError) {
    if (error.code === "forbidden" || error.code === "unauthenticated") {
      throw new EducateOsError(error.code, "the Cloudflare API token can't manage the gateway's provider keys: give it AI Gateway: Edit and Secrets Store: Edit");
    }
    if (error.status === 409) throw new EducateOsError("conflict", "the gateway already holds a key for this provider: replace it in the dashboard");
    if (error.status === 404) throw new EducateOsError("not-found", "the install's AI Gateway wasn't found in the account: run the install again");
  }
  throw error;
}

/** `ai <status|add|remove> [<provider>]`. */
export async function aiCommand(deps: AiDeps, sub: string | undefined, provider: string | undefined): Promise<number> {
  switch (sub ?? "status") {
    case "status":
      return await status(deps);
    case "add":
      return await add(deps, parseProvider(provider));
    case "remove":
      return await remove(deps, parseProvider(provider));
    default:
      throw new EducateOsError("validation-failed", `unknown ai command ${sub}: use status, add or remove`);
  }
}
