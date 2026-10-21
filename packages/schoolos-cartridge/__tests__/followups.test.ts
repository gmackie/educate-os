// SCHO-86: imported tools launch only through an approved registration, cartridge links keep
// their cartridge as their Content Studio source, and CASE-shaped GUIDs become suggestions only.
import { CatalogMirror, catalogSeedRelease, InMemoryCatalogMirrorStorage } from "@schoolos/catalog";
import { DistrictId, PrincipalId } from "@schoolos/contracts";
import { InMemoryToolRegistrationStore } from "@schoolos/lti";
import { describe, expect, it } from "vitest";
import { assertToolLaunchable } from "../src/index.ts";
import { standardsThinCc } from "./cartridges.ts";
import { BIO_SCOPE, fixture, importer, MORGAN } from "./helpers.ts";
import { buildZip } from "./zip-writer.ts";

const D = DistrictId.parse("dst_northfield");
const ADMIN = PrincipalId.parse("prn_nf-district-admin");

const registration = (overrides: Record<string, unknown> = {}) => ({
  id: "ltr_sim-co",
  districtId: D,
  name: "Simulation Co (synthetic)",
  domains: ["sim.tools.example"],
  clientId: "schoolos-client-77",
  deploymentId: "deployment-1",
  oidcLoginUrl: "https://sim.tools.example/lti/login",
  jwksUrl: "https://sim.tools.example/lti/jwks",
  status: "approved",
  approvedBy: ADMIN,
  approvedAt: "2026-10-01T09:00:00Z",
  ...overrides,
});

async function importWith(registrations: unknown[]) {
  const env = importer(undefined, { toolRegistrations: new InMemoryToolRegistrationStore(registrations) });
  const record = await env.importer.importPackage(MORGAN, { fileName: "ecosystems.imscc", targetScope: BIO_SCOPE }, fixture("thin-cc-valid.imscc"));
  return { ...env, record };
}

describe("imported tools and LTI registrations", () => {
  it("launches a tool only through the approved registration covering its host", async () => {
    const { importer: i, record } = await importWith([registration()]);
    expect(await i.toolLaunches(MORGAN, record.id)).toStrictEqual([{
      toolId: "tool-1",
      status: "launchable",
      launch: {
        registrationId: "ltr_sim-co",
        clientId: "schoolos-client-77",
        deploymentId: "deployment-1",
        // The login endpoint is the registration's; only the target link comes from the cartridge.
        oidcLoginUrl: "https://sim.tools.example/lti/login",
        targetLinkUri: "https://sim.tools.example/launch",
        customParams: { unit: "ecosystems", difficulty: "2" },
      },
    }]);
    // The stored reference is unchanged: launchability is decided afresh each time.
    expect((await i.getImport(MORGAN, record.id)).tools[0]).toMatchObject({ launchable: false, registration: "requires-registration" });
  });

  it("keeps a tool unlaunchable without exactly one approved registration for its exact host", async () => {
    const cases: [unknown[], string][] = [
      [[], "no-registration"],
      [[registration({ status: "suspended" })], "no-registration"],
      [[registration({ domains: ["tools.example"] })], "no-registration"],
      [[registration({ districtId: "dst_riverbend" })], "no-registration"],
      [[registration(), registration({ id: "ltr_other", clientId: "other" })], "ambiguous"],
    ];
    for (const [registrations, reason] of cases) {
      const { importer: i, record } = await importWith(registrations);
      expect(await i.toolLaunches(MORGAN, record.id)).toStrictEqual([{ toolId: "tool-1", status: "requires-registration", reason }]);
      expect(() => assertToolLaunchable(record.tools[0]!, [])).toThrow(expect.objectContaining({ code: "forbidden" }));
    }
  });

  it("refuses a registered host reached over plain http", async () => {
    const { record } = await importWith([]);
    const tool = { ...record.tools[0]!, launchUrl: "http://sim.tools.example/launch" };
    const registrations = await new InMemoryToolRegistrationStore([registration()]).list(D);
    expect(() => assertToolLaunchable(tool, registrations)).toThrow(/insecure-launch-url/);
    expect(assertToolLaunchable(record.tools[0]!, registrations).registrationId).toBe("ltr_sim-co");
  });
});

describe("cartridge links in the Content Studio", () => {
  it("records the cartridge as the item's source, and releases it like any URL", async () => {
    const { importer: i, studio, record } = await importWith([]);
    const { item } = await i.submitLinkForReview(MORGAN, record.id, "lnk-1");
    expect(item.source).toStrictEqual({
      kind: "cartridge",
      fileName: "ecosystems.imscc",
      packageDigest: record.packageDigest,
      importId: record.id,
      linkId: "lnk-1",
      submittedUrl: "https://open-lessons.example/photosynthesis",
      finalUrl: "https://open-lessons.example/photosynthesis",
      hops: ["https://open-lessons.example/photosynthesis"],
    });
    const release = await studio.approve(MORGAN, item.id, { alignments: [] });
    expect(release.descriptor).toMatchObject({ kind: "web-page", locator: "https://open-lessons.example/photosynthesis", provenance: { source: "official" } });
  });
});

/** A catalog mirror holding the CCSS Math seed, approved or only proposed, and its first item. */
async function catalogWith(approved: boolean) {
  const mirror = new CatalogMirror({ storage: new InMemoryCatalogMirrorStorage(), verifyRelease: async () => true });
  const actor = { by: ADMIN, at: "2026-10-01T09:00:00Z" };
  const release = await catalogSeedRelease("ccss-math");
  await mirror.select("ccss-math", actor);
  await mirror.install(release, actor);
  if (approved) await mirror.approve("ccss-math", release.version, actor);
  return { mirror, node: release.content.nodes![0]! };
}

/** The standards-tagged cartridge, claiming `guid` (in upper case, as cartridges often write it). */
async function taggedPackage(guid: string) {
  const entries = standardsThinCc().map((entry) => entry.path === "imsmanifest.xml"
    ? { ...entry, content: (entry.content as string).replace("9B4E1C2A-7D3F-4A5B-8C6D-0E1F2A3B4C5D", guid.toUpperCase()) }
    : entry);
  return buildZip(entries);
}

describe("CASE GUID suggestions", () => {
  it("suggests the approved catalog item a CASE-shaped GUID names, and never applies it", async () => {
    const { mirror, node } = await catalogWith(true);
    const env = importer(undefined, { catalog: mirror });
    const record = await env.importer.importPackage(MORGAN, { fileName: "energy.imscc", targetScope: BIO_SCOPE }, await taggedPackage(node.identifier));
    const suggestions = await env.importer.suggestAlignments(MORGAN, record.id);
    expect(suggestions).toStrictEqual([{
      linkId: "lnk-1",
      guid: node.identifier.toUpperCase(),
      claimedLabel: "MS-LS2-3",
      frameworkKey: "ccss-math",
      competencyUri: node.uri,
      humanCodingScheme: node.humanCodingScheme,
      fullStatement: node.fullStatement,
      basis: "case-item-guid",
    }]);
    // The provider code that is not CASE-shaped suggests nothing, and nothing is stored or aligned.
    expect(JSON.stringify(await env.importer.getImport(MORGAN, record.id))).not.toContain(node.uri);
  });

  it("suggests nothing from a release the district has not approved", async () => {
    const { mirror, node } = await catalogWith(false);
    const env = importer(undefined, { catalog: mirror });
    const record = await env.importer.importPackage(MORGAN, { fileName: "energy.imscc", targetScope: BIO_SCOPE }, await taggedPackage(node.identifier));
    expect(await env.importer.suggestAlignments(MORGAN, record.id)).toStrictEqual([]);
  });
});
