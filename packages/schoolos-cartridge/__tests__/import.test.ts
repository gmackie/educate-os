import { createHash } from "node:crypto";
import { CurriculumPack, LearningUnit } from "@schoolos/registry";
import { describe, expect, it } from "vitest";
import { assertToolLaunchable, CartridgeImport, ExternalToolReference } from "../src/index.ts";
import { validThinCc } from "./cartridges.ts";
import { AMARA, BIO_SCOPE, fixture, importer, MORGAN, rejectsWith, RIVERA } from "./helpers.ts";
import { buildZip } from "./zip-writer.ts";

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function importValid() {
  const env = importer();
  const bytes = fixture("thin-cc-valid.imscc");
  const record = await env.importer.importPackage(MORGAN, { fileName: "ecosystems.imscc", targetScope: BIO_SCOPE }, bytes);
  return { ...env, bytes, record };
}

describe("importing a Thin CC", () => {
  it("preserves the organization's hierarchy, including nested modules", async () => {
    const { record } = await importValid();
    expect(record.profile).toBe("thin-common-cartridge");
    expect(record.schemaVersion).toBe("1.3.0");
    expect(record.outline).toStrictEqual([
      {
        kind: "module",
        identifier: "I_WEEK1",
        title: "Week 1: Producers",
        children: [
          { kind: "link", identifier: "I_PHOTO", linkId: "lnk-1" },
          { kind: "module", identifier: "I_READINGS", title: "Extra readings", children: [{ kind: "link", identifier: "I_PLANTS", linkId: "lnk-2" }] },
        ],
      },
      {
        kind: "module",
        identifier: "I_WEEK2",
        title: "Week 2: Consumers",
        children: [
          { kind: "link", identifier: "I_FOODWEB", linkId: "lnk-3" },
          { kind: "tool", identifier: "I_SIM", toolId: "tool-1" },
        ],
      },
    ]);
  });

  it("records the package hash and item path as each link's and tool's provenance", async () => {
    const { record, bytes } = await importValid();
    expect(record.packageDigest).toBe(sha256(bytes));
    expect(record.links.find((link) => link.id === "lnk-2")!.provenance).toStrictEqual({
      packageDigest: sha256(bytes),
      itemPath: [
        { identifier: "I_WEEK1", title: "Week 1: Producers" },
        { identifier: "I_READINGS", title: "Extra readings" },
        { identifier: "I_PLANTS", title: "Plant adaptations" },
      ],
      resourceIdentifier: "WL_2",
      file: "WL_2/weblink.xml",
    });
    expect(record.tools[0]!.provenance.itemPath.map((step) => step.identifier)).toStrictEqual(["I_WEEK2", "I_SIM"]);
  });

  it("keeps the package's descriptive metadata as the publisher's claim", async () => {
    const { record } = await importValid();
    expect(record.metadata).toStrictEqual({
      title: "Ecosystems Unit (synthetic)",
      description: "A synthetic two-week unit on producers and consumers.",
      keywords: ["ecosystems", "food webs"],
      rights: "Licensed under CC BY 4.0 by Open Lessons Collective (synthetic).",
      copyrightRestricted: true,
      standards: [],
    });
  });

  it("quarantines web links without fetching any of them", async () => {
    const { record, web, studioStorage } = await importValid();
    expect(record.links.map((link) => [link.title, link.url, link.review])).toStrictEqual([
      ["Photosynthesis", "https://open-lessons.example/photosynthesis", { status: "quarantined" }],
      ["Plant Adaptations", "https://open-lessons.example/adaptations", { status: "quarantined" }],
      ["Food Webs", "https://open-lessons.example/food-webs", { status: "quarantined" }],
    ]);
    expect(web.requested).toStrictEqual([]);
    expect(await studioStorage.listItems()).toStrictEqual([]);
  });

  it("records a link the studio's URL checks would refuse as refused, so it can never be submitted", async () => {
    const { importer: cc, web } = importer();
    const bytes = await buildZip(validThinCc({ firstUrl: "https://169.254.169.254/latest/meta-data/" }));
    const record = await cc.importPackage(MORGAN, { fileName: "x.imscc", targetScope: BIO_SCOPE }, bytes);
    expect(record.links[0]!.review).toStrictEqual({ status: "refused", reason: "ip-literal" });
    await rejectsWith(cc.submitLinkForReview(MORGAN, record.id, "lnk-1"), "policy-violation");
    expect(web.requested).toStrictEqual([]);
  });

  it("only lets someone who may create resources at the target scope import", async () => {
    const { importer: cc, storage } = importer();
    const bytes = fixture("thin-cc-valid.imscc");
    await rejectsWith(cc.importPackage(AMARA, { fileName: "x.imscc", targetScope: BIO_SCOPE }, bytes), "forbidden");
    await rejectsWith(cc.importPackage(RIVERA, { fileName: "x.imscc", targetScope: BIO_SCOPE }, bytes), "forbidden");
    expect(await storage.listImports()).toStrictEqual([]);
  });

  it("hides an import from those who cannot read its scope", async () => {
    const { importer: cc, record } = await importValid();
    await rejectsWith(cc.getImport(RIVERA, record.id), "not-found");
    await rejectsWith(cc.submitLinkForReview(RIVERA, record.id, "lnk-1"), "not-found");
    await rejectsWith(cc.getImport(MORGAN, "cci_nope"), "not-found");
  });
});

describe("reviewing imported links", () => {
  it("submits a link to Content Studio review only when a teacher asks, and records where it came from", async () => {
    const { importer: cc, record, web } = await importValid();
    const { link, item } = await cc.submitLinkForReview(MORGAN, record.id, "lnk-3");
    expect(web.requested).toStrictEqual(["https://open-lessons.example/food-webs"]);
    expect(item).toMatchObject({ state: "reviewed", targetScope: BIO_SCOPE, source: { kind: "url", submittedUrl: "https://open-lessons.example/food-webs" } });
    expect(link.review).toMatchObject({ status: "submitted", contentItemId: item.id, by: MORGAN.principalId });

    const stored = await cc.getImport(MORGAN, record.id);
    expect(stored.links.map((l) => l.review.status)).toStrictEqual(["quarantined", "quarantined", "submitted"]);
    expect(await cc.findItemOrigin(MORGAN, item.id)).toStrictEqual({ importId: record.id, linkId: "lnk-3", provenance: link.provenance });
    expect(await cc.findItemOrigin(RIVERA, item.id)).toBeUndefined();
  });

  it("refuses to submit the same link twice", async () => {
    const { importer: cc, record, web } = await importValid();
    await cc.submitLinkForReview(MORGAN, record.id, "lnk-1");
    await rejectsWith(cc.submitLinkForReview(MORGAN, record.id, "lnk-1"), "conflict");
    await rejectsWith(cc.submitLinkForReview(MORGAN, record.id, "tool-1"), "not-found");
    expect(web.requested).toHaveLength(1);
  });

  it("proposes registry units and a pack from released links, following the hierarchy", async () => {
    const { importer: cc, studio, record } = await importValid();
    for (const linkId of ["lnk-1", "lnk-2", "lnk-3"]) {
      const { item } = await cc.submitLinkForReview(MORGAN, record.id, linkId);
      if (linkId !== "lnk-3") await studio.approve(MORGAN, item.id, { alignments: [] });
    }
    const proposal = await cc.proposeCurriculum(MORGAN, record.id);

    expect(proposal.units.map((unit) => unit.title)).toStrictEqual(["Week 1: Producers"]);
    expect(proposal.units[0]!.items).toHaveLength(2);
    for (const unit of proposal.units) expect(LearningUnit.safeParse(unit).success).toBe(true);
    expect(CurriculumPack.safeParse(proposal.pack).success).toBe(true);
    expect(proposal.pack).toMatchObject({ title: "Ecosystems Unit (synthetic)", review: { status: "unreviewed" }, provenance: { source: "derived", sourceRevision: record.packageDigest } });
    expect(proposal.unresolved).toStrictEqual([
      { identifier: "I_FOODWEB", kind: "link", reason: "not-released" },
      { identifier: "I_SIM", kind: "tool", reason: "requires-registration" },
    ]);
  });

  it("proposes no pack while nothing has been released", async () => {
    const { importer: cc, record } = await importValid();
    const proposal = await cc.proposeCurriculum(MORGAN, record.id);
    expect(proposal).toMatchObject({ units: [], pack: undefined });
    expect(proposal.unresolved.map((u) => u.reason)).toStrictEqual(["not-submitted", "not-submitted", "not-submitted", "requires-registration"]);
  });
});

describe("LTI links", () => {
  it("become external tool references that require registration and are never launchable", async () => {
    const { record } = await importValid();
    expect(record.tools).toStrictEqual([
      {
        id: "tool-1",
        kind: "external-tool",
        title: "Food Web Simulator",
        description: "An external simulation (synthetic).",
        launchUrl: "https://sim.tools.example/launch",
        domain: "sim.tools.example",
        customParams: { unit: "ecosystems", difficulty: "2" },
        vendor: { code: "sim-co", name: "Simulation Co (synthetic)" },
        registration: "requires-registration",
        launchable: false,
        metadata: { keywords: [], standards: [] },
        provenance: expect.objectContaining({ resourceIdentifier: "LTI_1", file: "LTI_1/basiclti.xml" }),
      },
    ]);
  });

  it("cannot be made launchable by a stored or tampered record", async () => {
    const { record } = await importValid();
    const tool = record.tools[0]!;
    expect(ExternalToolReference.safeParse({ ...tool, launchable: true }).success).toBe(false);
    expect(ExternalToolReference.safeParse({ ...tool, registration: "registered" }).success).toBe(false);
    expect(CartridgeImport.safeParse({ ...record, tools: [{ ...tool, launchable: true }] }).success).toBe(false);
    expect(() => assertToolLaunchable(tool)).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  it("drops a custom parameter named __proto__ without touching any prototype", async () => {
    const entries = validThinCc().map((entry) => entry.path === "LTI_1/basiclti.xml"
      ? { ...entry, content: (entry.content as string).replace(`name="unit"`, `name="__proto__"`) }
      : entry);
    const { importer: cc } = importer();
    const record = await cc.importPackage(MORGAN, { fileName: "x.imscc", targetScope: BIO_SCOPE }, await buildZip(entries));
    const params = record.tools[0]!.customParams;
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(params).toStrictEqual({ difficulty: "2" });
  });
});

describe("other fixtures", () => {
  it("maps curriculum standards metadata, flagging CASE-shaped GUIDs as candidates only", async () => {
    const { importer: cc } = importer();
    const record = await cc.importPackage(MORGAN, { fileName: "s.imscc", targetScope: BIO_SCOPE }, fixture("thin-cc-standards.imscc"));
    expect(record.schemaVersion).toBe("1.2.0");
    expect(record.links[0]!.metadata).toStrictEqual({
      keywords: ["energy flow"],
      standards: [
        { providerId: "CASE", region: "US", version: "2013", label: "MS-LS2-3", guid: "9B4E1C2A-7D3F-4A5B-8C6D-0E1F2A3B4C5D", caseItemGuid: "9b4e1c2a-7d3f-4a5b-8c6d-0e1f2a3b4c5d" },
        { providerId: "AB", region: "US-MI", label: "Science 7.2", guid: "AB-SYNTHETIC-0042" },
      ],
    });
  });

  it("reports and counts unsupported resources in a full CC, and keeps none of their content", async () => {
    const { importer: cc } = importer();
    const record = await cc.importPackage(MORGAN, { fileName: "full.imscc", targetScope: BIO_SCOPE }, fixture("full-cc-unsupported.imscc"));
    expect(record.profile).toBe("common-cartridge");
    expect(record.skipped.countsByType).toStrictEqual({
      webcontent: 1,
      "imsqti_xmlv1p2/imscc_xmlv1p1/assessment": 1,
      imsdt_xmlv1p1: 1,
      imswl_xmlv1p1: 1,
    });
    expect(record.skipped.entries.map((entry) => [entry.resourceIdentifier, entry.reason])).toStrictEqual([
      ["WC_1", "unsupported-type"],
      ["QTI_1", "unsupported-type"],
      ["DT_1", "unsupported-type"],
      ["NOPE", "missing-resource"],
      ["WL_2", "not-in-organization"],
    ]);
    expect(record.links.map((link) => link.url)).toStrictEqual(["https://course.example/"]);
    expect(record.tools.map((tool) => [tool.domain, tool.launchable])).toStrictEqual([["practice.tools.example", false]]);
    expect(record.ignoredEntries).toStrictEqual([{ path: "web_resources/link-to-secrets", reason: "symlink" }]);
    // Nothing executable crosses over: no file content is kept anywhere in the record.
    const stored = JSON.stringify(record);
    expect(stored).not.toContain("document.cookie");
    expect(stored).not.toContain("<script");
  });
});
