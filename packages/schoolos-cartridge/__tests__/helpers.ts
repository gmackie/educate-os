import { readFileSync } from "node:fs";
import { CatalogMirror, InMemoryCatalogMirrorStorage } from "@schoolos/catalog";
import {
  catalogAlignmentSource,
  ContentStudio,
  type ImportFetch,
  InMemoryContentStudioStorage,
} from "@schoolos/content-studio";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { type DistrictDirectorySnapshot, DistrictId, type PolicySettings, PrincipalId, type Scope, type VerifiedPrincipal } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@schoolos/policy";
import { expect } from "vitest";
import { CartridgeImporter, type CartridgeImporterOptions, type CartridgeLimits, InMemoryCartridgeImportStorage } from "../src/index.ts";

const D = DistrictId.parse("dst_northfield");

/** The policy floor the tests decide under: the conservative district defaults. */
const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "private",
  teacherObservation: "assigned-work-only",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** The district's one policy engine over `directory`. */
function policyEngine(directory: DistrictDirectorySnapshot) {
  const information = directoryPolicyInformation(InMemoryAcademicStore.seeded(directory), { effectivePolicy: async () => FLOOR });
  return { engine: new PolicyEngine({ information, audit: new InMemoryPolicyAuditSink() }) };
}
const subject = (id: string): VerifiedPrincipal => ({ principalId: PrincipalId.parse(id), districtId: D });

/** Teaches Biology, fall period 2. */
export const MORGAN = subject("prn_nf-morgan-lee");
/** Teaches English 9, fall period 3. */
export const RIVERA = subject("prn_nf-teacher-rivera");
/** A student in Biology. */
export const AMARA = subject("prn_nf-student-amara");

export const BIO_SCOPE = { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" } as Scope;

/** The committed bytes of a fixture package. */
export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${import.meta.dirname}/fixtures/${name}`));
}

const page = (title: string) => () =>
  new Response(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><p>${title}: synthetic lesson text.</p></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** A synthetic web serving the valid fixture's link targets, recording every URL requested. */
export function fakeWeb(): ImportFetch & { requested: string[] } {
  const routes: Record<string, () => Response> = {
    "https://open-lessons.example/photosynthesis": page("Photosynthesis"),
    "https://open-lessons.example/adaptations": page("Plant Adaptations"),
    "https://open-lessons.example/food-webs": page("Food Webs"),
  };
  const requested: string[] = [];
  const fetch = async (url: string) => {
    requested.push(url);
    return routes[url]?.() ?? new Response("not found", { status: 404 });
  };
  return Object.assign(fetch, { requested });
}

/** An importer over Northfield, its Content Studio and a synthetic web, with any `extra` options. */
export function importer(limits?: CartridgeLimits, extra: Pick<CartridgeImporterOptions, "toolRegistrations" | "catalog"> = {}) {
  const web = fakeWeb();
  const { engine: authorizer } = policyEngine(NORTHFIELD);
  const studioStorage = new InMemoryContentStudioStorage();
  let tick = 0;
  // Each call is a minute later, so timestamps order events.
  const now = () => new Date(Date.UTC(2026, 9, 20, 9, tick++)).toISOString();
  const studio = new ContentStudio({
    districtId: D,
    storage: studioStorage,
    authorizer,
    fetch: web,
    scanner: undefined,
    alignments: catalogAlignmentSource(new CatalogMirror({ storage: new InMemoryCatalogMirrorStorage(), verifyRelease: async () => true })),
    now,
  });
  const storage = new InMemoryCartridgeImportStorage();
  const instance = new CartridgeImporter({ districtId: D, storage, studio, authorizer, now, ...extra, ...(limits === undefined ? {} : { limits }) });
  return { importer: instance, studio, studioStorage, storage, web };
}

/** Expects a promise to reject with a SchoolOsError of `code`. */
export async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "SchoolOsError", code });
}

/** Expects a promise to reject as a refused cartridge, for `reason`. */
export async function refusedFor(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "SchoolOsError", code: "policy-violation", reason });
}
