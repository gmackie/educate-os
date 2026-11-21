// The installed district as `connect` and `status` reach it: its public origin and LTI origin
// (both from the answers file), its Worker's name (for Worker secrets, set with the install token
// through the Cloudflare API), and HTTP to the district itself.
//
// HTTP to the district comes in two kinds. The paths the installer exempts from Access
// (`/healthz`, `/.well-known/educateos.json`, `/lti/*`) need nothing. The administrators' API
// (`/api/lti/*`, `/api/admin/*`) sits behind the district's Access application, so it is called with
// a district administrator's own Access token (`cloudflared access token --app <origin>`), sent as
// `cf-access-token`, which Access exchanges for the assertion the district verifies. The token is
// sent to the district's origin only, redirects are never followed, and it is never saved or printed.
import { noResponse } from "../dns.ts";
import { EducateOsError, type ErrorCode } from "@educateos/contracts";
import { type DistrictInstallConfig, publicHostname, workerScriptName } from "@educateos/installer";
import type { Answers } from "../answers.ts";
import type { LaunchCloudflare } from "../cloudflare.ts";
import type { Output } from "../output.ts";
import type { Prompter } from "../prompter.ts";

/** The district Worker's package name in every release (its Worker name keeps it; SCHO-231). */
export const DISTRICT_PACKAGE = "educateos-district-worker";

/** The environment variable holding a district administrator's Access token for the admin API. */
export const ACCESS_TOKEN_ENV = "EDUCATEOS_ACCESS_TOKEN";

/** Where the installed district is. */
export interface DistrictTarget {
  accountId: string;
  /** The district's public origin: the LMS at `/`. */
  origin: string;
  /** The LTI Tool's origin (`LTI_TOOL_ORIGIN`): the public origin unless the answers keep another. */
  ltiOrigin: string;
  /** The district Worker's name, which holds the roster secrets. */
  scriptName: string;
  /** The Zero Trust team domain people sign in through. */
  accessTeamDomain: string;
}

/** The district an install runs, or undefined when it installed the AI Workshop alone. */
export function districtTarget(config: DistrictInstallConfig): DistrictTarget | undefined {
  const service = config.services[DISTRICT_PACKAGE];
  if (service?.enabled !== true) return undefined;
  const origin = `https://${publicHostname(config)}`;
  return {
    accountId: config.accountId,
    origin,
    ltiOrigin: config.ltiToolOrigin ?? origin,
    scriptName: service.scriptName ?? workerScriptName(config, DISTRICT_PACKAGE),
    accessTeamDomain: `${config.access.teamName}.cloudflareaccess.com`,
  };
}

/** What a connect flow or the status report works with. */
export interface ConnectContext {
  out: Output;
  /** Undefined without a terminal. */
  prompter: Prompter | undefined;
  /** Change the account without asking. */
  yes: boolean;
  /** The account, through the install token: asked for (or read from the environment) on first use. */
  cloudflare(): Promise<LaunchCloudflare>;
  config: DistrictInstallConfig;
  district: DistrictTarget;
  /** The answers file, which holds `DISTRICT_CONFIG`, and where it is. */
  answers: Answers;
  answersPath: string;
  /** The fetch every call to the district and the providers goes through. */
  fetch: typeof fetch;
  env: Readonly<Record<string, string | undefined>>;
  /** The flags given on the command line. */
  flags: ConnectFlags;
  /** The district administrator's Access session, once one is given. */
  admin?: DistrictAdmin | undefined;
}

/** The command-line flags the connect flows read. Every one is optional. */
export interface ConnectFlags {
  cleverDistrictId?: string | undefined;
  serviceAccountKey?: string | undefined;
  workspaceAdmin?: string | undefined;
  classroomRoster?: string | undefined;
  classroomScopes?: string | undefined;
  csvDir?: string | undefined;
  contextId?: string | undefined;
  offeringId?: string | undefined;
  deploymentId?: string | undefined;
  issuer?: string | undefined;
}

/** A public, unauthenticated read of the district. */
export interface Probe {
  status: number;
  /** The redirect target, when the district (or Access in front of it) redirected. */
  location?: string | undefined;
  body?: unknown;
}

/** GETs a path on `origin` without credentials. A network failure is status 0. */
export async function probe(fetchImpl: typeof fetch, origin: string, path: string): Promise<Probe> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, origin), { redirect: "manual", headers: { accept: "application/json, text/plain" } });
  } catch {
    return { status: 0 };
  }
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, location: response.headers.get("location") ?? undefined, body };
}

const ERROR_CODES = new Set<ErrorCode>(["unauthenticated", "forbidden", "not-found", "conflict", "validation-failed", "policy-violation", "budget-exceeded", "unavailable"]);

/** The district's administrators' API, as one signed-in administrator. */
export class DistrictAdmin {
  readonly #origin: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(origin: string, token: string, fetchImpl: typeof fetch) {
    this.#origin = origin;
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  /** Calls `path` on the district. Errors carry the district's own code and message, never the token. */
  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.#origin);
    if (url.origin !== this.#origin) throw new EducateOsError("validation-failed", "refusing to send the Access token off the district's origin");
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        redirect: "manual",
        headers: {
          "cf-access-token": this.#token,
          accept: "application/json",
          // Every POST is JSON, bodiless ones too: the district refuses anything a form could send.
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch (error) {
      throw new EducateOsError("unavailable", noResponse(this.#origin, error));
    }
    if (response.status >= 300 && response.status < 400) {
      throw new EducateOsError("unauthenticated",
        `Cloudflare Access did not accept the sign-in token for ${this.#origin}: get a fresh one with \`cloudflared access token --app ${this.#origin}\``);
    }
    const text = await response.text().catch(() => "");
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const failure = json as { code?: unknown; message?: unknown } | undefined;
      const code = typeof failure?.code === "string" && ERROR_CODES.has(failure.code as ErrorCode) ? failure.code as ErrorCode : "unavailable";
      const message = typeof failure?.message === "string" ? failure.message : `HTTP ${response.status}`;
      throw new EducateOsError(code, `${method} ${url.pathname}: ${message}`);
    }
    return json as T;
  }
}

/** Prints how a district administrator gets an Access token for the admin API. */
export function describeAccessToken(out: Output, origin: string): void {
  out.line("The district's admin API is behind Cloudflare Access, so these steps run as a district");
  out.line("administrator. On this machine, with Cloudflare's `cloudflared` installed:");
  out.line(`  cloudflared access login ${origin}`);
  out.line(`  cloudflared access token --app ${origin}`);
  out.line(`Paste the token it prints, or set ${ACCESS_TOKEN_ENV} to it. It is used for this run only and never saved.`);
}

/**
 * The administrator's session: {@link ACCESS_TOKEN_ENV}, or the token pasted on a terminal. Undefined
 * when there is neither (the flows then print the requests to make instead).
 */
export async function adminSession(context: ConnectContext): Promise<DistrictAdmin | undefined> {
  if (context.admin) return context.admin;
  let token = context.env[ACCESS_TOKEN_ENV];
  if (!token && context.prompter) {
    context.out.line();
    describeAccessToken(context.out, context.district.origin);
    token = await context.prompter.secret("Access token (blank to skip the admin API steps)");
  }
  if (!token) return undefined;
  context.out.secret(token);
  context.admin = new DistrictAdmin(context.district.origin, token, context.fetch);
  return context.admin;
}

/** Asks before a change to the account; `--yes` agrees. False without a terminal or `--yes`. */
export async function confirmChange(context: ConnectContext, question: string): Promise<boolean> {
  if (context.yes) return true;
  if (context.prompter === undefined) {
    context.out.line("Not changing anything: pass --yes to make this change without a terminal to confirm on.");
    return false;
  }
  return await context.prompter.confirm(question, true);
}

/** Sets one secret on the district Worker, after showing what will change and asking. */
export async function putDistrictSecret(context: ConnectContext, name: string, value: string): Promise<boolean> {
  const { district, out } = context;
  out.secret(value);
  const cf = await context.cloudflare();
  const existing = await cf.api.listWorkerSecrets(district.accountId, district.scriptName);
  out.line();
  out.line(`Plan: ${existing.includes(name) ? "replace" : "set"} the Worker secret ${name} on ${district.scriptName}.`);
  out.line("  (A Worker secret: encrypted by Cloudflare, never readable again, kept across upgrades.)");
  if (!(await confirmChange(context, `${existing.includes(name) ? "Replace" : "Set"} ${name}?`))) return false;
  await cf.api.putWorkerSecret(district.accountId, district.scriptName, name, value);
  out.line(`  Set ${name}.`);
  return true;
}

/** Prints one live check as `ok` or `FAIL`. */
export function printCheck(out: Output, check: { ok: boolean; detail: string }): void {
  out.line(`${check.ok ? "ok  " : "FAIL"}  ${check.detail}`);
}

/** A value from its flag, or asked on a terminal (blank for none). Undefined when neither gives one. */
export async function askValue(context: ConnectContext, flag: string | undefined, question: string, help?: string): Promise<string | undefined> {
  if (flag) return flag;
  if (!context.prompter) return undefined;
  if (help) context.out.line(`  ${help}`);
  const value = await context.prompter.text(question, { default: "" });
  return value === "" ? undefined : value;
}
