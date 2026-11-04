#!/usr/bin/env node

// Gives a standalone demo district (SCHO-326) its own fixture roster and the middle school starter
// pack, through the district's own admin routes, as a district administrator signed in through
// Cloudflare Access. Northfield's showcase is never seeded here (that is seed-showcase.ts).
//
//   <cookie> | node scripts/demo/seed-district.ts run --url https://riverbend.educateos.io [--dry-run] [--out <file>]
//   <cookie> | node scripts/demo/seed-district.ts export|verify --url <district> [--out <file>]
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
// The cookie is read from stdin, as in seed-showcase.ts. See docs/educateos/runbooks/demo-districts.md.

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DemoDistrict } from "../../packages/educateos-fixtures/src/index.ts";
import { AUTOMATION, demoFor, describePreview, isLocal, localSteps, nonAdditive, rosterFiles, type AuthoringDirectory, type LocalStep, type RosterPreview } from "./district-roster.ts";
import { ShowcaseRequestError, districtOrigin } from "./seed-showcase.ts";

/** The starter pack every demo district gets: the listing educateos.io publishes. */
export const STARTER_PACK = fileURLToPath(new URL("../../sites/educateos-io/public/marketplace/listings/middle-school-starter-pack/1.0.0.json", import.meta.url));

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The district's admin routes this script uses, as one administrator. */
export interface DistrictAdminClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
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
  return { get: (path) => request("GET", path), post: (path, body) => request("POST", path, body) };
}

/** The district's directory and work counts (`admin.health`). */
export interface DistrictHealth {
  districtId: string;
  directory: { schools: number; terms: number; offerings: number; students: number; staff: number; activeEnrollments: number };
}

/** An installed marketplace pack, as far as this script reads it. */
export interface InstalledPack {
  listingId: string;
  version: string;
}

/** The listing a bundle (`educateos.marketplace.listing/v1`) carries, from its signed payload. */
export function listingOf(bundle: unknown): InstalledPack {
  const payload = (bundle as { listing?: { payload?: { listingId?: unknown; version?: unknown } } }).listing?.payload;
  if (typeof payload?.listingId !== "string" || typeof payload.version !== "string") throw new Error("that is not a marketplace listing bundle");
  return { listingId: payload.listingId, version: payload.version };
}

/** The "before" record: everything the admin read routes say. */
export async function exportDistrict(client: DistrictAdminClient): Promise<Record<string, unknown>> {
  const [health, authoring, offerings, packs] = await Promise.all([
    client.get("/api/admin/health"),
    client.get("/api/admin/authoring"),
    client.get("/api/admin/offerings"),
    client.get("/api/admin/marketplace/packs"),
  ]);
  return { exportedAt: new Date().toISOString(), health, authoring, offerings, packs };
}

/** One line of counts. */
export const describeHealth = (h: DistrictHealth): string =>
  `${h.districtId}: ${h.directory.schools} schools, ${h.directory.terms} terms, ${h.directory.offerings} classes, ${h.directory.staff} staff, ${h.directory.students} students, ${h.directory.activeEnrollments} active enrollments`;

/**
 * Runs `steps` against a local district, creating only what `directory` lacks (matched by name,
 * title, section or sign-in). Returns how many of each it made.
 */
export async function seedLocal(client: DistrictAdminClient, steps: readonly LocalStep[], directory: AuthoringDirectory, log: (line: string) => void, dryRun: boolean): Promise<Record<string, number>> {
  const ids = new Map<string, string>();
  const made: Record<string, number> = {};
  const count = (kind: string) => (made[kind] = (made[kind] ?? 0) + 1);
  const rosters = new Map<string, { principalId: string; role: string }[]>();
  const rosterOf = async (offeringId: string) => {
    if (!rosters.has(offeringId)) {
      const roster = offeringId.startsWith("dry:") ? [] : await client.get<{ enrollment: { principalId: string; role: string; status: string } }[]>(`/api/admin/offerings/${offeringId}/roster`);
      rosters.set(offeringId, roster.map((e) => e.enrollment).filter((e) => e.status === "active"));
    }
    return rosters.get(offeringId)!;
  };
  const create = async <T extends { id: string }>(kind: string, path: string, body: unknown): Promise<string> => {
    count(kind);
    if (dryRun) return `dry:${kind}:${made[kind]}`;
    return (await client.post<T>(path, body)).id;
  };
  const people = new Map(directory.principals.map((p) => [p.displayName, p]));
  for (const step of steps) {
    switch (step.kind) {
      case "school":
        ids.set(step.fixtureId, directory.schools.find((s) => s.name === step.body.name)?.id ?? await create("schools", "/api/admin/schools", step.body));
        break;
      case "term":
        ids.set(step.fixtureId, directory.terms.find((t) => t.name === step.body.name)?.id ?? await create("terms", "/api/admin/terms", step.body));
        break;
      case "course":
        ids.set(step.fixtureId, directory.courses.find((c) => c.title === step.body.title)?.id ?? await create("courses", "/api/admin/courses", step.body));
        break;
      case "offering": {
        const body = { schoolId: ids.get(step.school)!, termId: ids.get(step.term)!, courseId: ids.get(step.course)!, sectionName: step.sectionName };
        const present = directory.offerings.find((o) => o.schoolId === body.schoolId && o.termId === body.termId && o.courseId === body.courseId && o.sectionName === body.sectionName);
        ids.set(step.fixtureId, present?.id ?? await create("offerings", "/api/admin/offerings", body));
        break;
      }
      case "principal": {
        const present = people.get(step.body.displayName);
        const id = present?.id ?? await create("principals", "/api/admin/principals", step.body);
        ids.set(step.fixtureId, id);
        if (step.districtAdmin && !present?.districtAdmin) {
          count("district admins");
          if (!dryRun) await client.post(`/api/admin/principals/${id}/district-admin`, {});
        }
        break;
      }
      case "enrollment": {
        const offeringId = ids.get(step.offering)!;
        const principalId = ids.get(step.principal)!;
        if ((await rosterOf(offeringId)).some((e) => e.principalId === principalId)) break;
        count("enrollments");
        if (!dryRun) await client.post(`/api/admin/offerings/${offeringId}/enrollments`, { principalId, role: step.role });
        break;
      }
    }
  }
  log(`${dryRun ? "would make" : "made"}: ${Object.entries(made).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing new"}`);
  return made;
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

/** Export, seed the roster (import or authoring), install the pack, verify. Returns the problems found (none: success). */
export async function runDistrict(options: RunOptions): Promise<string[]> {
  const { client, demo, dryRun } = options;
  const log = options.log ?? ((line) => console.log(line));
  const write = options.write ?? ((path, text) => writeFile(path, text, { flag: "wx", mode: 0o600 }));
  const before = await exportDistrict(client);
  await write(options.out, `${JSON.stringify(before, null, 2)}\n`);
  log(`saved the district's "before" state to ${options.out}`);
  log(`before: ${describeHealth(before.health as DistrictHealth)}`);
  const authoring = before.authoring as AuthoringDirectory;
  const admit = options.admitSubject === undefined ? {} : { admitSubject: options.admitSubject };

  if (isLocal(demo)) {
    if (authoring.authority.principal !== "local") return [`${demo.slug} is expected to be local-authority, but the district says principals belong to ${authoring.authority.principal}`];
    await seedLocal(client, localSteps(demo, admit), authoring, log, dryRun);
  } else {
    const files = rosterFiles(demo, admit);
    const preview = await client.post<RosterPreview>("/api/admin/roster/preview", { files });
    log(`roster preview: ${describePreview(preview)}`);
    for (const q of preview.quarantined) log(`  quarantined ${q.sourcedId}: ${q.message}`);
    const problems = nonAdditive(preview);
    const nothingNew = Object.values(preview.changes).every((c) => c.added.length === 0);
    if (problems.length > 0) return problems.map((p) => `roster: ${p}`);
    if (!dryRun && !nothingNew) {
      const applied = await client.post<{ applied: boolean; preview: RosterPreview; grantsRevoked: number }>("/api/admin/roster/apply", { files });
      if (!applied.applied) return [`roster: the district did not apply it: ${nonAdditive(applied.preview).join("; ")}`];
      log(`roster applied: ${describePreview(applied.preview)}`);
    }
    if (options.admitSubject !== undefined && !dryRun) {
      const after = await client.get<AuthoringDirectory>("/api/admin/authoring");
      const automation = after.principals.find((p) => p.displayName === AUTOMATION.displayName);
      if (automation === undefined) return ["the automation person is not in the directory after the import"];
      if (!automation.districtAdmin) await client.post(`/api/admin/principals/${automation.id}/district-admin`, {});
      log(`${AUTOMATION.displayName} (${automation.id}) is a district administrator`);
    }
  }

  const { listingId, version } = listingOf(options.pack);
  const packs = before.packs as InstalledPack[];
  if (packs.some((p) => p.listingId === listingId && p.version === version)) log(`${listingId} ${version} is already installed`);
  else if (dryRun) log(`would install ${listingId} ${version}`);
  else {
    const pack = await client.post<InstalledPack>("/api/admin/marketplace/packs", options.pack);
    log(`installed ${pack.listingId} ${pack.version}`);
  }
  return dryRun ? [] : verify(client, demo, listingId, log);
}

/** Checks the fixture's classes are all listed with students, and the pack is installed. */
export async function verify(client: DistrictAdminClient, demo: DemoDistrict, listingId: string, log: (line: string) => void): Promise<string[]> {
  const [health, offerings, packs] = await Promise.all([
    client.get<DistrictHealth>("/api/admin/health"),
    client.get<{ offering: { id: string; sectionName: string }; course: { title: string }; students: number }[]>("/api/admin/offerings"),
    client.get<InstalledPack[]>("/api/admin/marketplace/packs"),
  ]);
  log(`after: ${describeHealth(health)}; packs: ${packs.map((p) => `${p.listingId} ${p.version}`).join(", ") || "none"}`);
  const problems: string[] = [];
  const courses = new Map(demo.directory.courses.map((c) => [c.id, c.title]));
  for (const o of demo.directory.offerings) {
    const title = courses.get(o.courseId)!;
    const listed = offerings.find((row) => row.course.title === title && row.offering.sectionName === o.sectionName);
    if (listed === undefined) problems.push(`${title} · ${o.sectionName} is not in the admin console's classes`);
    else if (listed.students === 0 && demo.directory.enrollments.some((e) => e.offeringId === o.id && e.role === "student" && e.status === "active")) problems.push(`${title} · ${o.sectionName} has no students`);
  }
  if (!packs.some((p) => p.listingId === listingId)) problems.push(`${listingId} is not installed`);
  for (const problem of problems) log(`problem: ${problem}`);
  return problems;
}

const log = (line: string): void => console.log(line);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0]!.trim();
}

const USAGE = `usage: <CF_Authorization cookie> | seed-district.ts <run|export|verify> --url https://<slug>.educateos.io [--cookie <CF_Authorization>]
  run       [--dry-run] [--out <file>] [--admit-subject <Access user_uuid>] [--pack <listing bundle>]
  export    [--out <file>]`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      cookie: { type: "string" },
      out: { type: "string" },
      pack: { type: "string" },
      "admit-subject": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const command = positionals[0] ?? "run";
  const cookie = values.cookie ?? (values.url === undefined ? undefined : await readStdin());
  if (values.url === undefined || cookie === undefined || cookie === "") {
    console.error(USAGE);
    return 2;
  }
  const origin = districtOrigin(values.url);
  const demo = demoFor(origin);
  const client = adminClient(origin, cookie);
  const out = values.out ?? `district-export-${new URL(origin).hostname}-${new Date().toISOString().replaceAll(":", "-")}.json`;
  switch (command) {
    case "run": {
      const pack: unknown = JSON.parse(await readFile(values.pack ?? STARTER_PACK, "utf8"));
      const problems = await runDistrict({ client, demo, out, dryRun: values["dry-run"], pack, log, ...(values["admit-subject"] === undefined ? {} : { admitSubject: values["admit-subject"] }) });
      for (const problem of problems) console.error(`problem: ${problem}`);
      return problems.length === 0 ? 0 : 1;
    }
    case "export":
      await writeFile(out, `${JSON.stringify(await exportDistrict(client), null, 2)}\n`, { flag: "wx", mode: 0o600 });
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
