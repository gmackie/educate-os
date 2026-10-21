import { CatalogMirror, catalogSeedRelease, InMemoryCatalogMirrorStorage } from "@schoolos/catalog";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { DistrictDirectorySnapshot, DistrictId, type PolicySettings, PrincipalId, type Scope, type VerifiedPrincipal } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import { expect } from "vitest";
import {
  catalogAlignmentSource,
  ContentStudio,
  type ContentStudioOptions,
  type ImportFetch,
  InMemoryContentStudioStorage,
} from "../src/index.ts";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@schoolos/policy";

const D = DistrictId.parse("dst_northfield");

/**
 * Northfield with one test-only local grant: its district administrator is also a district-wide
 * curriculum admin. The fixture districts have no curriculum admin of their own.
 */
export const DIRECTORY = DistrictDirectorySnapshot.parse({
  ...NORTHFIELD,
  roleAssignments: [
    ...NORTHFIELD.roleAssignments,
    { principalId: "prn_nf-district-admin", role: "curriculum-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
  ],
});

/** The policy floor the tests decide under: the conservative district defaults. */
const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "private",
  teacherObservation: "assigned-work-only",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** The district's one policy engine over `directory`, with the audit trail it writes. */
export function policyEngine(directory: DistrictDirectorySnapshot) {
  const audit = new InMemoryPolicyAuditSink();
  const information = directoryPolicyInformation(InMemoryAcademicStore.seeded(directory), { effectivePolicy: async () => FLOOR });
  return { engine: new PolicyEngine({ information, audit }), audit };
}

const subject = (id: string): VerifiedPrincipal => ({ principalId: PrincipalId.parse(id), districtId: D });

/** Teaches Biology, fall period 2. */
export const MORGAN = subject("prn_nf-morgan-lee");
/** Teaches English 9, fall period 3. */
export const RIVERA = subject("prn_nf-teacher-rivera");
/** Co-teaches English 9: instructional staff, but not a teacher for approval purposes. */
export const CHEN = subject("prn_nf-teacher-chen");
/** The district-wide curriculum admin. */
export const CURRICULUM = subject("prn_nf-district-admin");
/** A student in Biology. */
export const AMARA = subject("prn_nf-student-amara");

export const DISTRICT_SCOPE: Scope = { level: "district", districtId: D };
export const BIO_SCOPE = { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" } as Scope;
export const ENG9_SCOPE = { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-eng9-fall-p3" } as Scope;
export const HIGH_SCHOOL_SCOPE = { level: "school", districtId: D, schoolId: "sch_nf-high" } as Scope;

/** A synthetic web: a fetch answering from a table of responses, recording every URL requested. */
export function fakeWeb(routes: Record<string, () => Response>): ImportFetch & { requested: string[] } {
  const requested: string[] = [];
  const fetch = async (url: string) => {
    requested.push(url);
    const route = routes[url];
    return route === undefined ? new Response("not found", { status: 404 }) : route();
  };
  return Object.assign(fetch, { requested });
}

export const html = (body: string, status = 200) => () =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });

/** A small, well-formed lesson page with a CC BY 4.0 license, attribution, language and alt text. */
export const LICENSED_PAGE = `<!doctype html>
<html lang="en">
<head>
  <title>Cell Structure &amp; Function</title>
  <link rel="canonical" href="https://open-lessons.example/cells">
  <link rel="license" href="https://creativecommons.org/licenses/by/4.0/">
  <meta name="author" content="Open Lessons Collective (synthetic)">
</head>
<body>
  <h1>Cells</h1>
  <p>Every living thing is made of cells. The membrane controls what enters and leaves the cell.</p>
  <img src="/cell.png" alt="A labelled plant cell">
</body>
</html>`;

/** An approved CCSS Math release in a catalog mirror, and one of its item URIs. */
export async function approvedCatalog() {
  const mirror = new CatalogMirror({ storage: new InMemoryCatalogMirrorStorage(), verifyRelease: async () => true });
  const actor = { by: CURRICULUM.principalId, at: "2026-10-01T09:00:00Z" };
  await mirror.select("ccss-math", actor);
  const release = await catalogSeedRelease("ccss-math");
  await mirror.install(release, actor);
  await mirror.approve("ccss-math", release.version, actor);
  const node = release.content.nodes![0]!;
  return { mirror, release, competencyUri: node.uri };
}

/** A studio over Northfield, with a synthetic web, no scanner configured and the approved catalog. */
export async function studio({ routes, ...options }: Partial<ContentStudioOptions> & { routes?: Record<string, () => Response> } = {}) {
  const storage = new InMemoryContentStudioStorage();
  const web = fakeWeb(routes ?? { "https://open-lessons.example/cells": html(LICENSED_PAGE) });
  const catalog = await approvedCatalog();
  const { engine, audit } = policyEngine(DIRECTORY);
  let tick = 0;
  const instance = new ContentStudio({
    districtId: D,
    storage,
    authorizer: engine,
    fetch: web,
    scanner: undefined,
    alignments: catalogAlignmentSource(catalog.mirror),
    // Each call is a minute later, so timestamps order events.
    now: () => new Date(Date.UTC(2026, 9, 20, 9, tick++)).toISOString(),
    ...options,
  });
  return { studio: instance, storage, web, catalog, audit };
}

/** Expects a promise to reject with a SchoolOsError of `code`. */
export async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "SchoolOsError", code });
}
