import { PrincipalId } from "@schoolos/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type CatalogRelease,
  CatalogMirror,
  catalogEntry,
  catalogSeedRelease,
  contentDigest,
  coverageReport,
  importCaseRelease,
  InMemoryCatalogMirrorStorage,
  type VerifyRelease,
} from "../src/index.ts";

// A Northfield administrator from @schoolos/fixtures; the mirror records actors, callers authorize.
const ADMIN = { by: PrincipalId.parse("prn_nf-district-admin"), at: "2026-10-20T09:00:00Z" };
const LATER = { ...ADMIN, at: "2026-10-21T09:00:00Z" };

const accept: VerifyRelease = async () => true;

function mirror(verifyRelease: VerifyRelease = accept) {
  const storage = new InMemoryCatalogMirrorStorage();
  return { storage, mirror: new CatalogMirror({ storage, verifyRelease }) };
}

/** A copy of `release` as `version`, with its content changed by `edit` and its digest recomputed. */
async function revised(release: CatalogRelease, version: string, edit: (content: CatalogRelease["content"]) => void) {
  const content = structuredClone(release.content);
  edit(content);
  return { ...release, version, content, contentDigest: await contentDigest(content) };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "SchoolOsError", code });
}

describe("catalog mirror", () => {
  it("refuses a release whose signature the verify hook rejects, and stores nothing", async () => {
    const verifyRelease = vi.fn<VerifyRelease>(async () => false);
    const { mirror: m } = mirror(verifyRelease);
    await m.select("ccss-math", ADMIN);
    const release = await catalogSeedRelease("ccss-math");

    await rejectsWith(m.install(release, ADMIN), "policy-violation");
    expect(verifyRelease).toHaveBeenCalledWith(release);
    expect((await m.get("ccss-math"))?.releases).toStrictEqual([]);
  });

  it("refuses content that does not match its digest, before asking the verify hook", async () => {
    const verifyRelease = vi.fn<VerifyRelease>(accept);
    const { mirror: m } = mirror(verifyRelease);
    await m.select("ccss-math", ADMIN);
    const release = await catalogSeedRelease("ccss-math");
    const tampered = structuredClone(release);
    tampered.content.nodes![0]!.fullStatement = "Tampered statement.";

    await rejectsWith(m.install(tampered, ADMIN), "validation-failed");
    expect(verifyRelease).not.toHaveBeenCalled();
  });

  it("installs only for a selected framework, as proposed until approved", async () => {
    const { mirror: m } = mirror();
    const release = await catalogSeedRelease("ccss-math");
    await rejectsWith(m.install(release, ADMIN), "not-found");

    await m.select("ccss-math", ADMIN);
    const { release: installed } = await m.install(release, ADMIN);
    expect(installed.status).toBe("proposed");
    expect(await m.approvedRelease("ccss-math")).toBeUndefined();
    await m.approve("ccss-math", release.version, ADMIN);
    expect((await m.approvedRelease("ccss-math"))?.contentDigest).toBe(release.contentDigest);
  });

  it("keeps an approved release immutable", async () => {
    const { mirror: m } = mirror();
    await m.select("ccss-math", ADMIN);
    const release = await catalogSeedRelease("ccss-math");
    const other = await revised(release, release.version, (c) => {
      c.nodes![0]!.notes = "Edited after release.";
    });

    // While proposed, the same version may be replaced by corrected bytes.
    await m.install(other, ADMIN);
    await m.install(release, ADMIN);
    await m.approve("ccss-math", release.version, ADMIN);

    await rejectsWith(m.install(other, LATER), "conflict");
    await rejectsWith(m.approve("ccss-math", release.version, LATER), "conflict");
    // Changing what the mirror handed back changes nothing stored.
    const approved = await m.approvedRelease("ccss-math");
    approved!.content.nodes![0]!.fullStatement = "Changed by a caller.";
    expect((await m.approvedRelease("ccss-math"))?.contentDigest).toBe(release.contentDigest);
    expect(await contentDigest((await m.approvedRelease("ccss-math"))!.content)).toBe(release.contentDigest);
  });

  it("upgrades with a diff of added, changed and retired items, and flags overlays left behind", async () => {
    const { mirror: m } = mirror();
    await m.select("ccss-math", ADMIN);
    const v1 = await catalogSeedRelease("ccss-math");
    await m.install(v1, ADMIN);
    await m.approve("ccss-math", v1.version, ADMIN);

    const [first, second] = v1.content.nodes!;
    await m.setOverlay("ccss-math", { nodeUri: second!.uri, localLabel: "Local label", author: ADMIN.by, updatedAt: ADMIN.at });
    const v2 = await revised(v1, "1.1.0", (c) => {
      c.nodes![0]!.fullStatement = "A revised statement.";
      c.nodes = c.nodes!.filter((n) => n.uri !== second!.uri);
      c.nodes.push({ ...first!, uri: "urn:schoolos:catalog:ccss-math:EXAMPLE.NEW", identifier: "0d4c2a5e-1111-4222-8333-444455556666", humanCodingScheme: "EXAMPLE.NEW" });
      // A new retrieval time alone is not a content change.
      c.nodes[2]!.provenance = { ...c.nodes[2]!.provenance, retrievedAt: "2026-10-21T00:00:00Z" };
    });

    const { diff } = await m.install(v2, LATER);
    expect(diff).toStrictEqual({
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      added: [{ uri: "urn:schoolos:catalog:ccss-math:EXAMPLE.NEW", humanCodingScheme: "EXAMPLE.NEW" }],
      changed: [{ uri: first!.uri, humanCodingScheme: first!.humanCodingScheme, fields: ["fullStatement"] }],
      retired: [{ uri: second!.uri, humanCodingScheme: second!.humanCodingScheme }],
      orphanedOverlays: [second!.uri],
    });
    // The old release stays in use until the upgrade is approved.
    expect((await m.approvedRelease("ccss-math"))?.version).toBe("1.0.0");
    expect(await m.approve("ccss-math", "1.1.0", LATER)).toStrictEqual(diff);
    const state = await m.get("ccss-math");
    expect(state?.releases.map((r) => [r.release.version, r.status])).toStrictEqual([["1.0.0", "retired"], ["1.1.0", "approved"]]);
    expect(await m.diff("ccss-math", "1.0.0", "1.1.0")).toStrictEqual(diff);
  });

  it("only overlays items of the approved release, and never changes the release", async () => {
    const { mirror: m } = mirror();
    await m.select("ccss-math", ADMIN);
    const release = await catalogSeedRelease("ccss-math");
    const nodeUri = release.content.nodes![0]!.uri;
    const overlay = { nodeUri, hidden: true, author: ADMIN.by, updatedAt: ADMIN.at };
    await m.install(release, ADMIN);
    await rejectsWith(m.setOverlay("ccss-math", overlay), "not-found");

    await m.approve("ccss-math", release.version, ADMIN);
    await m.setOverlay("ccss-math", overlay);
    await rejectsWith(m.setOverlay("ccss-math", { ...overlay, nodeUri: "urn:schoolos:catalog:ccss-math:NOT.THERE" }), "not-found");
    expect((await m.get("ccss-math"))?.overlays).toStrictEqual([overlay]);
    expect((await m.approvedRelease("ccss-math"))?.contentDigest).toBe(release.contentDigest);
  });

  it("refuses a write based on a stale read", async () => {
    const { storage, mirror: m } = mirror();
    const state = await m.select("ccss-math", ADMIN);
    await storage.put({ ...state, revision: 2 });
    await rejectsWith(storage.put({ ...state, revision: 2 }), "conflict");
  });
});

describe("importing from a CASE source", () => {
  const document = {
    identifier: "5a0f6a0e-0000-4000-8000-000000000001",
    uri: "https://case.publisher.example/uri/5a0f6a0e-0000-4000-8000-000000000001",
    creator: "Example State Education Agency",
    title: "Synthetic Standards",
    lastChangeDateTime: "2026-09-01T00:00:00Z",
  };
  const pkg = {
    CFDocument: document,
    CFItems: [{
      identifier: "5a0f6a0e-0000-4000-8000-000000000002",
      uri: "https://case.publisher.example/uri/5a0f6a0e-0000-4000-8000-000000000002",
      fullStatement: "A synthetic high-school expectation.",
      humanCodingScheme: "HS.1",
      educationLevel: ["09", "10", "11", "12"],
      lastChangeDateTime: "2026-09-01T00:00:00Z",
    }],
  };
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(pkg), { headers: { "content-type": "application/json" } });
  };
  const options = { fetch, version: "2026.10.0", importedAt: "2026-10-20T09:00:00Z" };

  it("records content from the publisher's own server as official, and from a mirror as derived", async () => {
    const teks = catalogEntry("teks");
    const fromPublisher = await importCaseRelease(teks, teks.caseSources[0]!.documentIdentifier, options);
    expect(calls.at(-1)).toBe(`${teks.caseSources[0]!.serviceBaseUrl}/CFPackages/${teks.caseSources[0]!.documentIdentifier}`);
    expect(fromPublisher.content.nodes!.map((n) => n.provenance.source)).toStrictEqual(["official"]);

    const ngss = catalogEntry("ngss");
    const fromMirror = await importCaseRelease(ngss, ngss.caseSources[0]!.documentIdentifier, options);
    expect(fromMirror.content.nodes!.map((n) => n.provenance.source)).toStrictEqual(["derived"]);
    expect(fromMirror.content.framework.provenance).toMatchObject({ source: "derived", sourceUri: ngss.caseSources[0]!.documentUri });
  });

  it("imports only from a source the catalog entry declares", async () => {
    await rejectsWith(importCaseRelease(catalogEntry("ngss"), "5a0f6a0e-0000-4000-8000-000000000009", options), "not-found");
  });

  it("brings imported text into coverage once the district approves it", async () => {
    const { mirror: m } = mirror();
    await m.select("ccss-math", ADMIN);
    const before = coverageReport(await m.selections());
    expect(before.cells.find((c) => c.subject === "mathematics" && c.band === "9-12")?.status).toBe("import-required");

    const entry = catalogEntry("ccss-math");
    const imported = await importCaseRelease(entry, entry.caseSources[0]!.documentIdentifier, options);
    await m.install(imported, ADMIN);
    await m.approve("ccss-math", imported.version, ADMIN);
    const after = coverageReport(await m.selections());
    expect(after.cells.find((c) => c.subject === "mathematics" && c.band === "9-12")?.status).toBe("covered");
  });
});
