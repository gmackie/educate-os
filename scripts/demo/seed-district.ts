#!/usr/bin/env node

// Gives a standalone demo district (SCHO-326) its own fixture roster and the middle school starter
// pack, through the district's own admin routes, as a district administrator signed in through
// Cloudflare Access. Northfield's showcase is never seeded here (that is seed-showcase.ts).
//
//   <cookie> | node scripts/demo/seed-district.ts run --url https://riverbend.educateos.io [--dry-run] [--out <file>]
//   <cookie> | node scripts/demo/seed-district.ts export|verify --url <district> [--out <file>]
//   node scripts/demo/seed-district.ts run|export|verify --url <district> --operator-token-env <VAR> [...]
//
// A roster district (riverbend, cedarvalley, lakeshore, harbor) gets its fixture as a OneRoster 1.2
// bulk CSV export built from `oneRosterSeed` (`admin.previewRoster`, then `admin.applyRoster`). The
// fixture's district administrator is left out of the export, since the seed already holds them under
// the operator's sign-in. The local-authority district (prairie) gets its fixture through the
// authoring routes (`admin.createSchool` ... `admin.enroll`), matched by name so a rerun only adds
// what is missing. Either way, a roster person signs in under the Access team as their fixture
// username, which no Access subject (a UUID) matches: nobody is anyone until an administrator links
// them. Guardians are not created (the roster import skips them, and authoring creates only students
// and staff).
//
// Only additive. `run` first saves the "before" state (`admin.health`, `admin.authoring`,
// `admin.listOfferings`, `admin.listMarketplacePacks`) to `--out` (mode 600, never overwriting), and
// refuses an import whose preview would change, deactivate or relink anything already there.
//
// `--admit-subject <Access user_uuid>` also adds "EducateOS demo automation" as a staff person
// signed in by that subject and makes them a district administrator, so an agent's test identity
// (admin@agents.gmac.io) can administer the district afterwards. In a roster district there is no
// other way to give a sign-in a person: a roster district refuses `admin.createPrincipal`.
//
// The cookie is read from stdin, as in seed-showcase.ts. With `--operator-token-env <VAR>` there is
// no cookie: the script calls the district's operator route (`/api/demo/operator/*`, see
// packages/educateos-district-worker/src/demo-operator.ts) with the bearer token in that environment
// variable, and the district runs the same seed in-process as its own district administrator. The
// token is never printed. The run itself lives in @educateos/harness/demo-district, so both paths
// seed exactly alike. See docs/educateos/runbooks/demo-districts.md.

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  demoFor,
  exportDistrict,
  seedDemoDistrict,
  verify,
  type DemoDistrict,
  type DistrictAdminClient,
} from "../../packages/educateos-harness/src/demo-district.ts";
import { ShowcaseRequestError, districtOrigin } from "./seed-showcase.ts";

export { listingOf, seedLocal, verify, type DistrictAdminClient } from "../../packages/educateos-harness/src/demo-district.ts";

/** The starter pack every demo district gets: the listing educateos.io publishes. */
export const STARTER_PACK = fileURLToPath(new URL("../../sites/educateos-io/public/marketplace/listings/middle-school-starter-pack/1.0.0.json", import.meta.url));

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Reads a JSON answer, throwing a {@link ShowcaseRequestError} for a redirect, no JSON, or an error status. */
async function readAnswer<T>(response: Response, label: string, redirected: string): Promise<T> {
  const text = await response.text();
  if (response.status >= 300 && response.status < 400) throw new ShowcaseRequestError(response.status, redirected);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ShowcaseRequestError(response.status, `${label} answered ${response.status} with no JSON`);
  }
  if (!response.ok) {
    const { code, message } = parsed as { code?: string; message?: string };
    throw new ShowcaseRequestError(response.status, `${label} answered ${response.status} ${code ?? ""}: ${message ?? ""}`.trim());
  }
  return parsed as T;
}

/** A client for `origin`'s admin routes, signed in by an Access `CF_Authorization` cookie. */
export function adminClient(origin: string, cookie: string, fetch: Fetch = globalThis.fetch.bind(globalThis)): DistrictAdminClient {
  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method,
      redirect: "manual",
      headers: { cookie: `CF_Authorization=${cookie}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return readAnswer<T>(response, `${method} ${path}`, "Access did not accept the cookie (expired, or for another application); sign in again");
  }
  return { get: (path) => request("GET", path), post: (path, body) => request("POST", path, body) };
}

/** What {@link runDistrict} needs. */
export interface RunOptions {
  client: DistrictAdminClient;
  demo: DemoDistrict;
  /** Where to save the "before" export. */
  out: string;
  dryRun: boolean;
  /** An Access subject to add as the automation district administrator. */
  admitSubject?: string;
  /** The listing bundle to install. */
  pack: unknown;
  write?: (path: string, text: string) => Promise<void>;
  log?: (line: string) => void;
}

/** Saves `text` to `path`, mode 600, never overwriting. */
const saveNew = (path: string, text: string) => writeFile(path, text, { flag: "wx", mode: 0o600 });

/** Export (saved to `out` first), seed the roster (import or authoring), install the pack, verify. Returns the problems found (none: success). */
export async function runDistrict(options: RunOptions): Promise<string[]> {
  const log = options.log ?? ((line) => console.log(line));
  const write = options.write ?? saveNew;
  const { problems } = await seedDemoDistrict({
    client: options.client,
    demo: options.demo,
    dryRun: options.dryRun,
    pack: options.pack,
    log,
    ...(options.admitSubject === undefined ? {} : { admitSubject: options.admitSubject }),
    saveBefore: async (before) => {
      await write(options.out, `${JSON.stringify(before, null, 2)}\n`);
      log(`saved the district's "before" state to ${options.out}`);
    },
  });
  return problems;
}

// Operator token (SCHO-326)

/** The shortest operator token the district accepts. */
export const MIN_OPERATOR_TOKEN_LENGTH = 32;

/** What the district's operator seed route answers (`OperatorSeedResult` in demo-operator.ts). */
export interface OperatorSeedAnswer {
  districtId: string;
  slug: string;
  dryRun: boolean;
  adminPrincipalId: string;
  before: Record<string, unknown>;
  log: string[];
  problems: string[];
}

/** What the district's operator status route answers. */
export interface OperatorStatusAnswer {
  districtId: string;
  slug: string;
  adminPrincipalId: string;
  export: Record<string, unknown>;
  problems: string[];
}

/** The operator token in `variable`, or an error that names the variable and never the value. */
export function operatorToken(variable: string, env: NodeJS.ProcessEnv = process.env): string {
  const token = env[variable]?.trim();
  if (token === undefined || token === "") throw new Error(`${variable} is not set`);
  if (token.length < MIN_OPERATOR_TOKEN_LENGTH) throw new Error(`${variable} is shorter than ${MIN_OPERATOR_TOKEN_LENGTH} characters`);
  return token;
}

/** A client for `origin`'s operator routes, with the bearer token: no Access sign-in. */
export function operatorClient(origin: string, token: string, fetch: Fetch = globalThis.fetch.bind(globalThis)) {
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const redirected = "Access redirected the request: is /api/demo/operator/* in the demo districts' bypass application?";
  return {
    async status(): Promise<OperatorStatusAnswer> {
      const response = await fetch(`${origin}/api/demo/operator/status`, { method: "GET", redirect: "manual", headers });
      return readAnswer(response, "GET /api/demo/operator/status", redirected);
    },
    async seed(body: { dryRun?: boolean; admitSubject?: string }): Promise<OperatorSeedAnswer> {
      const response = await fetch(`${origin}/api/demo/operator/seed`, {
        method: "POST",
        redirect: "manual",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return readAnswer(response, "POST /api/demo/operator/seed", redirected);
    },
  };
}

/** What {@link runOperator} needs. */
export interface OperatorRunOptions {
  client: ReturnType<typeof operatorClient>;
  demo: DemoDistrict;
  /** Where to save the "before" export the district returns. */
  out: string;
  dryRun: boolean;
  admitSubject?: string;
  write?: (path: string, text: string) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Seeds through the operator route: the district exports, seeds and verifies in-process, and this
 * saves the "before" export it returns. Refused when the district is not the one `demo` names.
 * Returns the problems found (none: success).
 */
export async function runOperator(options: OperatorRunOptions): Promise<string[]> {
  const log = options.log ?? ((line) => console.log(line));
  const write = options.write ?? saveNew;
  const answer = await options.client.seed({ dryRun: options.dryRun, ...(options.admitSubject === undefined ? {} : { admitSubject: options.admitSubject }) });
  await write(options.out, `${JSON.stringify(answer.before, null, 2)}\n`);
  log(`saved the district's "before" state to ${options.out}`);
  if (answer.slug !== options.demo.slug) return [`the district says it is ${answer.slug}, not ${options.demo.slug}`];
  log(`seeded as ${answer.adminPrincipalId}`);
  for (const line of answer.log) log(line);
  return answer.problems;
}

const log = (line: string): void => console.log(line);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0]!.trim();
}

const USAGE = `usage: <CF_Authorization cookie> | seed-district.ts <run|export|verify> --url https://<slug>.educateos.io [--cookie <CF_Authorization>]
       seed-district.ts <run|export|verify> --url https://<slug>.educateos.io --operator-token-env <VAR>
  run       [--dry-run] [--out <file>] [--admit-subject <Access user_uuid>] [--pack <listing bundle> (cookie only)]
  export    [--out <file>]`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      cookie: { type: "string" },
      "operator-token-env": { type: "string" },
      out: { type: "string" },
      pack: { type: "string" },
      "admit-subject": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const command = positionals[0] ?? "run";
  if (values.url === undefined) {
    console.error(USAGE);
    return 2;
  }
  const origin = districtOrigin(values.url);
  const demo = demoFor(origin);
  const out = values.out ?? `district-export-${new URL(origin).hostname}-${new Date().toISOString().replaceAll(":", "-")}.json`;
  const admit = values["admit-subject"] === undefined ? {} : { admitSubject: values["admit-subject"] };

  const tokenVariable = values["operator-token-env"];
  if (tokenVariable !== undefined) {
    if (values.cookie !== undefined || values.pack !== undefined) {
      console.error("--operator-token-env takes no --cookie, and the district installs its own bundled starter pack (no --pack)");
      return 2;
    }
    const client = operatorClient(origin, operatorToken(tokenVariable));
    switch (command) {
      case "run": {
        const problems = await runOperator({ client, demo, out, dryRun: values["dry-run"], log, ...admit });
        for (const problem of problems) console.error(`problem: ${problem}`);
        return problems.length === 0 ? 0 : 1;
      }
      case "export": {
        const status = await client.status();
        await saveNew(out, `${JSON.stringify(status.export, null, 2)}\n`);
        log(`saved the district's "before" state to ${out}`);
        return 0;
      }
      case "verify": {
        const status = await client.status();
        for (const problem of status.problems) console.error(`problem: ${problem}`);
        log(`${status.slug}: ${status.problems.length === 0 ? "every fixture class is listed with students, and the starter pack is installed" : `${status.problems.length} problems`}`);
        return status.problems.length === 0 ? 0 : 1;
      }
      default:
        console.error(USAGE);
        return 2;
    }
  }

  const cookie = values.cookie ?? await readStdin();
  if (cookie === "") {
    console.error(USAGE);
    return 2;
  }
  const client = adminClient(origin, cookie);
  switch (command) {
    case "run": {
      const pack: unknown = JSON.parse(await readFile(values.pack ?? STARTER_PACK, "utf8"));
      const problems = await runDistrict({ client, demo, out, dryRun: values["dry-run"], pack, log, ...admit });
      for (const problem of problems) console.error(`problem: ${problem}`);
      return problems.length === 0 ? 0 : 1;
    }
    case "export":
      await saveNew(out, `${JSON.stringify(await exportDistrict(client), null, 2)}\n`);
      log(`saved the district's "before" state to ${out}`);
      return 0;
    case "verify":
      return (await verify(client, demo, "middle-school-starter-pack", log)).length === 0 ? 0 : 1;
    default:
      console.error(USAGE);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
