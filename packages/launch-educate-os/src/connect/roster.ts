// Clever and Google Classroom roster sync, as the district Worker runs them (district.ts's
// `workerRosterSource`): a credential in a Worker secret on the district Worker, the connection in
// the district's configuration, and the sync itself started by the hourly schedule or an
// administrator. Each flow checks the credential against the provider before storing it.
import { EducateOsError } from "@educateos/contracts";
import { clever, googleclassroom } from "@educateos/integrations";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { readDistrictConfig, withDistrictConfig } from "./district-config.ts";
import { adminSession, askValue, type ConnectContext, type DistrictAdmin, printCheck, putDistrictSecret } from "./district.ts";
import type { Check, ConnectOutcome } from "./outcome.ts";

/** The district Worker's secret holding the district-app token Clever issued (SCHO-203). */
export const CLEVER_TOKEN_SECRET = "CLEVER_DISTRICT_TOKEN";
/** The district Worker's secret holding the Classroom service account's JSON key (SCHO-255). */
export const CLASSROOM_KEY_SECRET = "GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY";
/** The environment variable `connect clever` reads the district-app token from. */
export const CLEVER_TOKEN_ENV = "EDUCATEOS_CLEVER_DISTRICT_TOKEN";
/** Google's issuer, which the district must trust for Classroom-rostered people. */
export const GOOGLE_ISSUER = "https://accounts.google.com";

/** What `GET /api/admin/roster/sync` answers. */
export interface RosterSyncStatus {
  provider: string;
  runnable: boolean;
  reason?: string;
  runs: { status?: string; finishedAt?: string; startedAt?: string }[];
}

/** The district's roster sync status, as an administrator sees it. */
export async function rosterSyncStatus(admin: DistrictAdmin): Promise<RosterSyncStatus> {
  return await admin.call<RosterSyncStatus>("GET", "/api/admin/roster/sync");
}

/** Prints the roster sync status after a connect flow, when an administrator's session is at hand. */
async function syncCheck(context: ConnectContext, provider: string): Promise<Check | undefined> {
  const admin = await adminSession(context);
  if (!admin) return undefined;
  const status = await rosterSyncStatus(admin);
  const check: Check = status.provider !== provider
    ? { name: "roster-sync", ok: false, detail: `the district's roster provider is ${status.provider}, not ${provider}: set it in the admin console (below)` }
    : status.runnable
      ? { name: "roster-sync", ok: true, detail: `the district can sync from ${provider} now (${status.runs.length} earlier run(s))` }
      : { name: "roster-sync", ok: false, detail: `the district can't sync yet: ${status.reason ?? "no reason given"}` };
  printCheck(context.out, check);
  return check;
}

const CleverList = z.object({ data: z.array(z.object({ data: z.object({ id: z.string(), name: z.string().optional() }) })) });

/** Reads Clever with the token as the district Worker will: the district it reads, then one user (roster scope). */
export async function checkCleverToken(fetchImpl: typeof fetch, token: string, districtId: string): Promise<Check> {
  const get = async (path: string) => {
    try {
      return await fetchImpl(`${clever.CLEVER_API_BASE}/${path}`, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" });
    } catch {
      return undefined;
    }
  };
  const districts = await get("districts");
  if (districts === undefined) return { name: "clever-token", ok: false, detail: "no response from api.clever.com" };
  if (districts.status === 401) return { name: "clever-token", ok: false, detail: "Clever refused the token (401): copy the district-app token again" };
  if (districts.status === 403) return { name: "clever-token", ok: false, detail: "Clever answered 403 for API v3.1, which EducateOS reads: the Clever application must be on API v3.1 (Clever offers it under a Clever Complete agreement)" };
  const parsed = CleverList.safeParse(await districts.json().catch(() => undefined));
  if (!districts.ok || !parsed.success) return { name: "clever-token", ok: false, detail: `Clever answered HTTP ${districts.status} for /districts` };
  const found = parsed.data.data.map((entry) => entry.data);
  if (!found.some((d) => d.id === districtId)) {
    return { name: "clever-token", ok: false, detail: `the token reads ${found.map((d) => d.id).join(", ") || "no district"}, not ${districtId}` };
  }
  const users = await get("users?limit=1");
  if (users === undefined || !users.ok) {
    return { name: "clever-token", ok: false, detail: `the token reads the district but not its users (HTTP ${users?.status ?? 0}): the application needs roster (Secure Sync) access to your district's data` };
  }
  const name = found.find((d) => d.id === districtId)?.name;
  return { name: "clever-token", ok: true, detail: `the token reads Clever district ${districtId}${name ? ` (${name})` : ""} and its users` };
}

/** Connects Clever roster sync: the district-app token, checked, then stored on the district Worker. */
export async function connectClever(context: ConnectContext): Promise<ConnectOutcome> {
  const { out, prompter, flags, env, district } = context;
  const checks: Check[] = [];
  out.line("Before you start: your district connected to the Clever application you sync through, sharing");
  out.line("rostering data, and its district-app token. In Clever's developer dashboard (https://apps.clever.com),");
  out.line("open the application, then your district: Clever shows the district's ID (24 hex digits) and its");
  out.line("district-app token. The token reads only your district.");
  out.line();
  const districtId = await askValue(context, flags.cleverDistrictId, "Clever district ID");
  if (!districtId) return { integration: "clever", status: "pending", checks, nextSteps: ["Re-run with --clever-district-id <id>."] };
  if (!/^[0-9a-f]{24}$/.test(districtId)) throw new EducateOsError("validation-failed", "a Clever district ID is 24 hex digits");
  const token = env[CLEVER_TOKEN_ENV] ?? (prompter ? await prompter.secret("Clever district-app token") : undefined);
  if (!token) return { integration: "clever", status: "pending", checks, nextSteps: [`Set ${CLEVER_TOKEN_ENV} to the district-app token and re-run.`] };
  out.secret(token);

  out.line();
  const check = await checkCleverToken(context.fetch, token, districtId);
  checks.push(check);
  printCheck(out, check);
  if (!check.ok) return { integration: "clever", status: "failed", checks, nextSteps: [check.detail] };
  if (!(await putDistrictSecret(context, CLEVER_TOKEN_SECRET, token))) {
    return { integration: "clever", status: "skipped", checks, nextSteps: ["Nothing was stored."] };
  }

  const config = readDistrictConfig(context.answers) ?? {};
  const nextSteps = [
    `In the district admin console (${district.origin}/admin), set the roster integration: provider clever, Clever district ${districtId}, identity mapping issuer https://clever.com with subject userIds (Clever IDs), and a sync schedule. Then preview and run the first sync there.`,
  ];
  if (config.authority !== "clever") nextSteps.push("Set DISTRICT_CONFIG.authority to \"clever\" (the Clever roster owns every record), in educateos-install.json, and apply with `npx launch-educate-os`.");
  if (config.rosterServicePrincipalId === undefined) nextSteps.push("For the hourly sync, set DISTRICT_CONFIG.rosterServicePrincipalId to a service principal with district administration; without it, administrators run each sync themselves.");
  const sync = await syncCheck(context, "clever");
  if (sync) checks.push(sync);
  return { integration: "clever", status: sync?.ok ? "connected" : "pending", checks, nextSteps };
}

/** Google's description of a service account key file: the parts this flow reads. */
const KeyFile = z.object({ type: z.literal("service_account"), client_email: z.email(), client_id: z.string().optional() });

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new EducateOsError("validation-failed", `${path} is not a readable JSON file`);
  }
}

/** Gets a delegated token as the Workspace administrator, then lists one course, as the district's sync will. */
export async function checkClassroomKey(fetchImpl: typeof fetch, key: string, admin: string, scopes: readonly string[]): Promise<Check> {
  let token: string;
  try {
    token = await googleclassroom.serviceAccountTokens({ key, scopes, fetch: fetchImpl, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, maxRetryAfterMs: 0 } }).token(admin);
  } catch (error) {
    const why = error instanceof Error && error.name === "RosterSyncError" ? error.message : "the token request failed";
    return { name: "classroom-delegation", ok: false, detail: `Google refused a token for ${admin}: ${why}. Check the domain-wide delegation (client ID and exactly these scopes).` };
  }
  let response: Response | undefined;
  try {
    response = await fetchImpl(`${googleclassroom.CLASSROOM_API}/courses?pageSize=1&courseStates=ACTIVE`, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" });
  } catch {
    response = undefined;
  }
  if (response === undefined) return { name: "classroom-delegation", ok: false, detail: "no response from classroom.googleapis.com" };
  if (!response.ok) {
    return { name: "classroom-delegation", ok: false, detail: `the Classroom API answered HTTP ${response.status}: enable the Classroom API in the service account's Cloud project, and Classroom data access in the Admin console` };
  }
  return { name: "classroom-delegation", ok: true, detail: `delegation works: the service account reads Classroom as ${admin}` };
}

const date = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? undefined : "Use YYYY-MM-DD.");
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

/** A minimal roster configuration, asked on a terminal: one term, one school, every active course. */
async function askRosterConfig(context: ConnectContext): Promise<unknown> {
  const { prompter, out } = context;
  if (!prompter) return undefined;
  out.line("Classroom has no terms or schools, so EducateOS needs one of each to file courses under (more schools,");
  out.line("listed courses and a default school can be set in a file: see docs/educateos/integrations/google-classroom.md).");
  const title = await prompter.text("Term title", { default: "2026-27" });
  const startDate = await prompter.text("Term start date", { validate: date });
  const endDate = await prompter.text("Term end date", { validate: date });
  const name = await prompter.text("School name");
  const grades = (await prompter.text("Grades it teaches (OneRoster codes, comma-separated, e.g. 09,10,11,12)")).split(/[\s,]+/).filter(Boolean);
  const domains = context.config.access.allowedEmailDomains;
  return {
    term: { sourcedId: `term-${slug(title)}`, title, startDate, endDate },
    schools: [{ sourcedId: `school-${slug(name)}`, name, grades }],
    courseSelection: "all",
    ...(domains.length > 0 ? { domains } : {}),
  };
}

/** Connects Google Classroom roster sync: the service account's key, checked, then the district's configuration. */
export async function connectGoogleClassroom(context: ConnectContext): Promise<ConnectOutcome> {
  const { out, flags, district } = context;
  const checks: Check[] = [];
  const readWrite = flags.classroomScopes === "read-write";
  if (flags.classroomScopes !== undefined && flags.classroomScopes !== "readonly" && !readWrite) {
    throw new EducateOsError("validation-failed", "--classroom-scopes is readonly or read-write");
  }
  const scopes = readWrite ? googleclassroom.CLASSROOM_ROSTER_SCOPES_READ_WRITE : googleclassroom.CLASSROOM_ROSTER_SCOPES;
  out.line("Before you start: a Google Workspace super administrator, and a Google Cloud project for the district.");
  out.line("  1. In the Cloud console, enable the Google Classroom API, create a service account, and create a JSON key for it.");
  out.line("  2. In the Admin console: Apps > Google Workspace > Classroom > Data access: allow Classroom API access.");
  out.line("  3. Admin console: Security > Access and data control > API controls > Domain-wide delegation > Add new:");
  out.line("     the service account's client ID, with exactly these scopes:");
  out.line(`       ${scopes.join(",")}`);
  out.line();
  const keyPath = await askValue(context, flags.serviceAccountKey, "Path to the service account's JSON key file");
  if (!keyPath) return { integration: "google-classroom", status: "pending", checks, nextSteps: ["Re-run with --service-account-key <file>."] };
  const keyJson = await readJsonFile(resolve(keyPath));
  const parsedKey = KeyFile.safeParse(keyJson);
  if (!parsedKey.success) throw new EducateOsError("validation-failed", `${keyPath} is not a Google service account key`);
  const key = JSON.stringify(keyJson);
  out.secret((keyJson as { private_key?: string }).private_key);
  out.line(`Service account ${parsedKey.data.client_email}${parsedKey.data.client_id ? `, client ID ${parsedKey.data.client_id} (the one to delegate)` : ""}.`);
  const admin = await askValue(context, flags.workspaceAdmin, "A Workspace administrator's email (the sync reads Classroom as them)");
  if (!admin) return { integration: "google-classroom", status: "pending", checks, nextSteps: ["Re-run with --workspace-admin <email>."] };

  out.line();
  const check = await checkClassroomKey(context.fetch, key, admin, scopes);
  checks.push(check);
  printCheck(out, check);
  if (!check.ok) return { integration: "google-classroom", status: "failed", checks, nextSteps: [check.detail] };

  // The roster configuration: a file, the one already configured, or a minimal one asked for.
  const current = readDistrictConfig(context.answers);
  if (current === undefined) throw new EducateOsError("not-found", "the answers file has no DISTRICT_CONFIG");
  const existing = (current.classroom as { roster?: unknown } | undefined)?.roster;
  const rawRoster = flags.classroomRoster ? await readJsonFile(resolve(flags.classroomRoster)) : existing ?? await askRosterConfig(context);
  if (rawRoster === undefined) return { integration: "google-classroom", status: "pending", checks, nextSteps: ["Re-run with --classroom-roster <file> (a ClassroomRosterConfig JSON)."] };
  const roster = googleclassroom.ClassroomRosterConfig.safeParse(rawRoster);
  if (!roster.success) throw new EducateOsError("validation-failed", `the Classroom roster configuration is not valid:\n${z.prettifyError(roster.error)}`);

  if (!(await putDistrictSecret(context, CLASSROOM_KEY_SECRET, key))) {
    return { integration: "google-classroom", status: "skipped", checks, nextSteps: ["Nothing was stored."] };
  }
  const trusted = (current.additionalTrustedIssuers as string[] | undefined) ?? [];
  context.answers = withDistrictConfig(context.answers, (config) => ({
    ...config,
    classroom: { admin, roster: rawRoster, rosterScopes: readWrite ? "read-write" : "readonly" },
    additionalTrustedIssuers: trusted.includes(GOOGLE_ISSUER) ? trusted : [...trusted, GOOGLE_ISSUER],
  }));
  out.line(`  Set DISTRICT_CONFIG.classroom (acting as ${admin}) and trusted ${GOOGLE_ISSUER}, in ${context.answersPath}.`);
  return {
    integration: "google-classroom",
    status: "pending",
    checks,
    answersChanged: true,
    nextSteps: [
      "Apply the configuration change: `npx launch-educate-os` with the saved answers (connect offers to do it now).",
      `In the district admin console (${district.origin}/admin), set the roster integration: provider google-classroom, identity mapping issuer ${GOOGLE_ISSUER} with subject username. Then preview and run the first sync there.`,
      "Run `npx launch-educate-os status` to check the sync can run.",
    ],
  };
}
