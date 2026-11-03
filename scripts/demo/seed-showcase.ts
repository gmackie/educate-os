#!/usr/bin/env node

// Seeds a live demo district with the K-12 showcase (SCHO-326) and links presenters to its
// personas, through the district's own demo routes (`/api/demo/showcase/*`, see
// packages/educateos-district-worker/src/showcase.ts). The district does the work in its own
// process; this script only asks, as a district administrator signed in through Cloudflare Access.
//
//   node scripts/demo/seed-showcase.ts run --url https://northfield.educateos.io [--dry-run] [--band K-2 ...] [--out <file>]
//   node scripts/demo/seed-showcase.ts export|verify|personas --url <district>
//   node scripts/demo/seed-showcase.ts link --url <district> --persona <prn_…|none> (--subject <uuid> | --subject-cookie <cookie>)
//
// The administrator's `CF_Authorization` cookie is read from stdin (agent-inbox's scripts/access-sign-in.ts
// prints one, so pipe it in), which keeps it out of the process list; `--cookie` also takes it. `run` first saves the "before" export (the whole directory and
// its counts) to `--out`, never overwriting a file, then does a dry run, seeds band by band (each band is
// one request to the district, to keep each well inside a request's CPU time), and verifies.
// An Access service token passes Access but is no person, and the district's demo routes answer only a
// district administrator, so there is no service-token mode. Only the demo districts' hosts are accepted
// unless `--force`. See docs/educateos/runbooks/demo-districts.md.

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** The grade bands, in the order `run` seeds them. */
export const BANDS = ["K-2", "3-5", "6-8", "9-12"] as const;
/** A grade band. */
export type Band = (typeof BANDS)[number];

/** The demo districts' hosts: the six `<slug>.educateos.io` and the co-op's old hostname. */
export const DEMO_HOSTS: readonly string[] = [
  ...["northfield", "riverbend", "prairie", "cedarvalley", "lakeshore", "harbor"].map((slug) => `${slug}.educateos.io`),
  "district.schoolos.gmac.io",
];

/** The district's origin, if it is a demo district's (or `force`); throws otherwise. */
export function districtOrigin(url: string, force = false): string {
  const parsed = new URL(url);
  if (!force && parsed.protocol !== "https:") throw new Error(`${parsed.origin} is not https; pass --force to use it anyway`);
  if (!force && !DEMO_HOSTS.includes(parsed.hostname)) {
    throw new Error(`${parsed.hostname} is not a demo district (${DEMO_HOSTS.join(", ")}); pass --force to use it anyway`);
  }
  return parsed.origin;
}

/** What the district says of the showcase it holds (`ShowcaseStatus` in the district Worker). */
export interface ShowcaseStatus {
  showcase: string;
  districtId: string;
  bands: Record<Band, { offerings: { offeringId: string; title: string; present: boolean; assignments: number; students: number }[]; assignments: number }>;
  personas: { present: number; linked: number };
}

/** One persona a presenter can be. */
export interface ShowcasePersona {
  principalId: string;
  displayName: string;
  kind: string;
  bands: Band[];
  classes: string[];
  presenters: string[];
}

/** What a seed request answers. */
export interface SeedOutcome {
  dryRun: boolean;
  directory: Record<string, number>;
  bands: Band[];
  guardiansConfirmed?: number;
  showcase?: { created: number; skipped: string[]; bands: Record<Band, Record<string, number>> };
}

/** A refusal from the district or from Access. */
export class ShowcaseRequestError extends Error {
  /** The HTTP status. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ShowcaseRequestError";
    this.status = status;
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The district's demo routes, as one administrator. */
export interface ShowcaseClient {
  exportDistrict(): Promise<Record<string, unknown>>;
  status(): Promise<ShowcaseStatus>;
  seed(body: { dryRun?: boolean; bands?: Band[] }): Promise<SeedOutcome>;
  personas(): Promise<ShowcasePersona[]>;
  link(subject: string, personaId: string | null): Promise<{ personaId: string | null; previousPersonaId: string | null; changed: boolean }>;
  /** The offerings the admin console lists, by ID. */
  adminOfferingIds(): Promise<string[]>;
}

/** A client for `origin`'s demo routes, signed in by an Access `CF_Authorization` cookie. */
export function showcaseClient(origin: string, cookie: string, fetch: Fetch = globalThis.fetch.bind(globalThis)): ShowcaseClient {
  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method,
      // Access answers a missing or expired session with a redirect to its sign-in page; never follow it.
      redirect: "manual",
      headers: { cookie: `CF_Authorization=${cookie}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.status >= 300 && response.status < 400) {
      throw new ShowcaseRequestError(response.status, "Access did not accept the cookie (expired, or for another application); sign in again");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ShowcaseRequestError(response.status, `${method} ${path} answered ${response.status} with no JSON`);
    }
    if (!response.ok) {
      const { code, message } = parsed as { code?: string; message?: string };
      throw new ShowcaseRequestError(response.status, `${method} ${path} answered ${response.status} ${code ?? ""}: ${message ?? ""}`.trim());
    }
    return parsed as T;
  }
  return {
    exportDistrict: () => request("GET", "/api/demo/showcase/export"),
    status: () => request("GET", "/api/demo/showcase"),
    seed: (body) => request("POST", "/api/demo/showcase/seed", body),
    personas: () => request("GET", "/api/demo/showcase/personas"),
    link: (subject, personaId) => request("POST", "/api/demo/showcase/personas", { subject, personaId }),
    adminOfferingIds: async () => (await request<{ offering: { id: string } }[]>("GET", "/api/admin/offerings")).map((o) => o.offering.id),
  };
}

/** The Access subject (`user_uuid`) a `CF_Authorization` cookie signs in, from Access's own identity endpoint. */
export async function accessSubject(origin: string, cookie: string, fetch: Fetch = globalThis.fetch.bind(globalThis)): Promise<{ subject: string; email?: string }> {
  const response = await fetch(`${origin}/cdn-cgi/access/get-identity`, { redirect: "manual", headers: { cookie: `CF_Authorization=${cookie}` } });
  const body = await response.json().catch(() => undefined) as { user_uuid?: unknown; email?: unknown } | undefined;
  if (!response.ok || typeof body?.user_uuid !== "string") throw new ShowcaseRequestError(response.status, "Access did not say who that cookie signs in");
  return { subject: body.user_uuid, ...(typeof body.email === "string" ? { email: body.email } : {}) };
}

/** What is missing or empty in the showcase the district holds, for `bands`; empty when it is all there. */
export function verifyShowcase(status: ShowcaseStatus, listed: readonly string[], bands: readonly Band[] = BANDS): string[] {
  const problems: string[] = [];
  for (const band of bands) {
    for (const offering of status.bands[band]?.offerings ?? []) {
      const label = `${band} ${offering.title} (${offering.offeringId})`;
      if (!offering.present) problems.push(`${label} is not in the directory`);
      else if (!listed.includes(offering.offeringId)) problems.push(`${label} is not in the admin console's offerings`);
      if (offering.assignments === 0) problems.push(`${label} has no activities`);
      if (offering.students < 2) problems.push(`${label} has ${offering.students} students`);
    }
    if ((status.bands[band]?.offerings.length ?? 0) === 0) problems.push(`${band} has no showcase classes`);
  }
  return problems;
}

/** One line per band: its classes, activities and students. */
export function describeStatus(status: ShowcaseStatus): string[] {
  return [
    `${status.districtId}: showcase ${status.showcase}, ${status.personas.present} personas (${status.personas.linked} linked)`,
    ...BANDS.map((band) => {
      const { offerings, assignments } = status.bands[band];
      const present = offerings.filter((o) => o.present).length;
      return `  ${band}: ${present}/${offerings.length} classes, ${assignments} activities, ${offerings.reduce((n, o) => n + o.students, 0)} student places`;
    }),
  ];
}

/** What {@link runShowcase} needs. */
export interface RunOptions {
  client: ShowcaseClient;
  /** Where to save the export. */
  out: string;
  /** Stop after the export and the dry run. */
  dryRun: boolean;
  bands: readonly Band[];
  /** Writes the export; never overwrites. */
  write?: (path: string, text: string) => Promise<void>;
  log?: (line: string) => void;
}

/** Export, dry run, seed band by band, verify. Returns the problems verification found (none: success). */
export async function runShowcase(options: RunOptions): Promise<string[]> {
  const log = options.log ?? ((line) => console.log(line));
  const write = options.write ?? ((path, text) => writeFile(path, text, { flag: "wx", mode: 0o600 }));
  const exported = await options.client.exportDistrict();
  await write(options.out, `${JSON.stringify(exported, null, 2)}\n`);
  log(`saved the district's export to ${options.out}`);

  const plan = await options.client.seed({ dryRun: true, bands: [...options.bands] });
  log(`the directory would gain: ${Object.entries(plan.directory).map(([k, n]) => `${n} ${k}`).join(", ")}`);
  if (options.dryRun) return [];

  for (const band of options.bands) {
    const outcome = await options.client.seed({ bands: [band] });
    const made = outcome.showcase?.bands[band] ?? {};
    log(`${band}: made ${Object.entries(made).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing new"}`
      + (outcome.guardiansConfirmed ? `; ${outcome.guardiansConfirmed} guardians confirmed` : "")
      + (outcome.showcase?.skipped.length ? `; skipped ${outcome.showcase.skipped.join("; ")}` : ""));
  }
  return verify(options.client, options.bands, log);
}

async function verify(client: ShowcaseClient, bands: readonly Band[], log: (line: string) => void): Promise<string[]> {
  const status = await client.status();
  for (const line of describeStatus(status)) log(line);
  const problems = verifyShowcase(status, await client.adminOfferingIds(), bands);
  for (const problem of problems) log(`problem: ${problem}`);
  return problems;
}

/** The first line of stdin: the cookie, piped in. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0]!.trim();
}

const log = (line: string): void => console.log(line);

const USAGE = `usage: <CF_Authorization cookie> | seed-showcase.ts <run|export|verify|personas|link> --url <district> [--cookie <CF_Authorization>]
  run       [--dry-run] [--band K-2 ...] [--out <file>]
  export    [--out <file>]
  link      --persona <prn_…|none> (--subject <uuid> | --subject-cookie <CF_Authorization of the presenter>)
  --force   accept a host that is not a demo district's`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      cookie: { type: "string" },
      out: { type: "string" },
      band: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      persona: { type: "string" },
      subject: { type: "string" },
      "subject-cookie": { type: "string" },
    },
  });
  const command = positionals[0] ?? "run";
  const cookie = values.cookie ?? (values.url === undefined ? undefined : await readStdin());
  if (values.url === undefined || cookie === undefined || cookie === "") {
    console.error(USAGE);
    return 2;
  }
  const origin = districtOrigin(values.url, values.force);
  const client = showcaseClient(origin, cookie);
  const bands = (values.band ?? [...BANDS]).map((band) => {
    if (!(BANDS as readonly string[]).includes(band)) throw new Error(`${band} is not a band (${BANDS.join(", ")})`);
    return band as Band;
  });
  const out = values.out ?? `showcase-export-${new URL(origin).hostname}-${new Date().toISOString().replaceAll(":", "-")}.json`;
  switch (command) {
    case "run":
      return (await runShowcase({ client, out, dryRun: values["dry-run"], bands, log })).length === 0 ? 0 : 1;
    case "export":
      await writeFile(out, `${JSON.stringify(await client.exportDistrict(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
      log(`saved the district's export to ${out}`);
      return 0;
    case "verify":
      return (await verify(client, bands, log)).length === 0 ? 0 : 1;
    case "personas":
      for (const p of await client.personas()) {
        log(`${p.principalId}\t${p.kind}\t${p.bands.join(",") || "-"}\t${p.displayName}\t${p.presenters.length > 0 ? `linked: ${p.presenters.join(", ")}` : ""}`);
      }
      return 0;
    case "link": {
      if (values.persona === undefined || (values.subject === undefined) === (values["subject-cookie"] === undefined)) {
        console.error(USAGE);
        return 2;
      }
      const presenter: { subject: string; email?: string } = values.subject !== undefined
        ? { subject: values.subject }
        : await accessSubject(origin, values["subject-cookie"]!);
      const outcome = await client.link(presenter.subject, values.persona === "none" ? null : values.persona);
      const who = presenter.email ?? presenter.subject;
      log(outcome.changed
        ? `${who} is now ${outcome.personaId ?? "no persona"}${outcome.previousPersonaId === null ? "" : ` (was ${outcome.previousPersonaId})`}`
        : `${who} was already ${outcome.personaId ?? "no persona"}`);
      return 0;
    }
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
