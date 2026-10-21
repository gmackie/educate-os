import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SigningIdentity } from "@schoolos/fleet";
import { sha256Digest, type ArtifactView } from "@schoolos/learning-artifacts";
import {
  consentGrantDigest,
  decodeTransfer,
  DirectTransferChannel,
  encodeTransfer,
  issueTransferConsent,
  issueTransferPackage,
  LearnerCarriedChannel,
  receiveLearnerCarriedTransfer,
  revokeTransferConsent,
  type TransferConsent,
  type TransferItemClass,
  type TransferPackage,
} from "../src/index.ts";
import { amarasYear, FORBIDDEN_STRINGS } from "./scenario.ts";
import { editJson, P, rejectsWith, rewrite, setup } from "./setup.ts";
import { NORTHFIELD_PARTY, R, riverbend, RIVERBEND_PARTY, RIVERBEND_TRANSFER_HOST, ROOT_HOST, TestNetwork } from "./transfer-setup.ts";

const AGE_POLICY = { selfConsentAge: 13 };
const ALL: TransferItemClass[] = ["artifacts", "submissions", "feedback", "resources"];
const ENDPOINT = `https://${RIVERBEND_TRANSFER_HOST}/api/transfers`;
const decoder = new TextDecoder();

/** Amara's export from Northfield, with the Northfield agent key that signs its transfers. */
async function northfieldExport() {
  const source = setup();
  await amarasYear(source);
  const exported = await source.exporter.exportStudentArchive(P.amara);
  const identity = await SigningIdentity.generate();
  const consentFor = (overrides: Partial<{ itemClasses: TransferItemClass[]; validForDays: number; destination: typeof RIVERBEND_PARTY }> = {}) =>
    issueTransferConsent(AGE_POLICY, {
      manifest: exported.manifest,
      learnerAge: 16,
      consentedBy: "learner",
      itemClasses: overrides.itemClasses ?? ALL,
      source: NORTHFIELD_PARTY,
      destination: overrides.destination ?? RIVERBEND_PARTY,
      validForDays: overrides.validForDays ?? 30,
    }, source.clock.now);
  const signed = (consent: TransferConsent = consentFor(), archive = exported.bytes) => issueTransferPackage(identity, archive, consent, source.clock.now);
  return { source, exported, identity, consentFor, signed, pinned: [{ ...NORTHFIELD_PARTY, publicKey: identity.publicKey }] };
}

/** Every imported artifact in Amara's Riverbend personal workspace, with its latest content as text. */
async function importedWork(dest: ReturnType<typeof riverbend>) {
  const personal = await dest.workspaces.ensurePersonalWorkspace(R.amara);
  const views = await dest.artifacts.listArtifacts(R.amara, personal.id);
  return Promise.all(views.map(async (view: ArtifactView) => {
    const { content } = await dest.artifacts.readRevision(R.amara, view.artifact.id);
    const text = content.kind === "text" ? content.text : content.kind === "external" ? content.url : decoder.decode(content.bytes);
    return { view, text };
  }));
}

let globalFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // Nothing may reach the network except through the fetch a test injects.
  globalFetch = vi.fn(async () => {
    throw new Error("global fetch used");
  });
  vi.stubGlobal("fetch", globalFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a direct transfer from Northfield to Riverbend", () => {
  it("delivers Amara's authorized work to her Riverbend account, and no student data goes via the root", async () => {
    const nf = await northfieldExport();
    const dest = riverbend({ pinned: nf.pinned });
    await dest.linkLearner(nf.exported.manifest.subject, R.amara);
    const network = new TestNetwork();
    network.route(RIVERBEND_TRANSFER_HOST, (request) => dest.endpoint.handle(request));
    network.route(ROOT_HOST, (request) => dest.root.fetch(request));

    const delivery = await new DirectTransferChannel({ endpoint: ENDPOINT, fetch: network.fetch }).send(await nf.signed());

    expect(delivery).toMatchObject({ kind: "pushed", outcome: "imported" });
    expect(network.requests).toEqual([ENDPOINT]);
    expect(dest.root.calls).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();

    const work = await importedWork(dest);
    const byTitle = new Map(work.map((w) => [w.view.artifact.title, w]));
    expect([...byTitle.keys()].toSorted()).toEqual([
      "Biology textbook, chapter 3",
      "Cell membranes essay",
      "Feedback on Osmosis lab",
      "How cells work",
      "Osmosis lab report",
      "Submission: Osmosis lab",
    ]);
    expect(byTitle.get("Cell membranes essay")!.text).toBe("Cells are small.\n\nMembranes control what enters.");
    const essayHistory = await dest.artifacts.history(R.amara, byTitle.get("Cell membranes essay")!.view.artifact.id);
    expect(essayHistory.map((r) => r.aiAssistance.level)).toEqual(["assisted", "none"]);
    expect(byTitle.get("Feedback on Osmosis lab")!.text).toContain("Clear method. Next time, add a control group.");
    expect(byTitle.get("Submission: Osmosis lab")!.view.artifact.type).toBe("evidence");

    // Everything is new, Riverbend-local and personal, wherever it was made at Northfield.
    for (const { view } of work) {
      expect(view.artifact).toMatchObject({ districtId: "dst_riverbend", ownerPrincipalId: "prn_rb-student-amara", classification: "personal-private", scope: { level: "district", districtId: "dst_riverbend" } });
    }
    const [record] = dest.ledger.all();
    expect(record).toMatchObject({
      archiveDigest: await sha256Digest(nf.exported.bytes),
      exportId: nf.exported.exportId,
      source: NORTHFIELD_PARTY,
      sourceVerification: "verified",
      channel: "direct",
      targetPrincipalId: "prn_rb-student-amara",
    });
    // The Docs link points at Northfield's document host, which Riverbend has not approved.
    expect(record!.skipped).toEqual([{ item: expect.any(String), itemClass: "artifacts", reason: "link-host-not-approved" }]);
  });

  it("imports nothing a learner may not take: no peer work, teacher-only notes, credentials or district IDs", async () => {
    const nf = await northfieldExport();
    const dest = riverbend({ pinned: nf.pinned });
    await dest.linkLearner(nf.exported.manifest.subject, R.amara);
    const pkg = await nf.signed();
    await dest.importer.importStudentArchive(pkg.archive, pkg.signature, pkg.consent, { principal: R.amara, channel: "direct" });

    const everything = (await importedWork(dest)).map((w) => `${w.view.artifact.title}\n${w.text}`).join("\n");
    for (const forbidden of FORBIDDEN_STRINGS) expect(everything).not.toContain(forbidden);
    expect(everything).not.toMatch(/\b(?:prn|art|sub|wsp|off)_nf-/);
  });

  it("keeps imported work from Riverbend teachers", async () => {
    const nf = await northfieldExport();
    const dest = riverbend({ pinned: nf.pinned });
    await dest.linkLearner(nf.exported.manifest.subject, R.amara);
    const pkg = await nf.signed();
    await dest.importer.importStudentArchive(pkg.archive, pkg.signature, pkg.consent, { principal: R.amara, channel: "direct" });

    const [record] = dest.ledger.all();
    for (const { artifactId } of record!.imported) {
      await rejectsWith(dest.artifacts.getArtifact(R.morgan, artifactId), "not-found");
      await rejectsWith(dest.artifacts.getArtifact(R.ines, artifactId), "not-found");
    }
    await rejectsWith(dest.artifacts.listArtifacts(R.morgan, record!.workspaceId), "not-found");
  });

  it("is idempotent on the archive digest", async () => {
    const nf = await northfieldExport();
    const dest = riverbend({ pinned: nf.pinned });
    await dest.linkLearner(nf.exported.manifest.subject, R.amara);
    const network = new TestNetwork();
    network.route(RIVERBEND_TRANSFER_HOST, (request) => dest.endpoint.handle(request));
    const channel = new DirectTransferChannel({ endpoint: ENDPOINT, fetch: network.fetch });
    const pkg = await nf.signed();

    const first = await channel.send(pkg);
    const again = await channel.send(pkg);
    const uploaded = await receiveLearnerCarriedTransfer(dest.importer, encodeTransfer(pkg), R.amara);

    expect(first).toMatchObject({ outcome: "imported" });
    expect(again).toMatchObject({ outcome: "already-imported", imported: (first as { imported: number }).imported });
    expect(uploaded.outcome).toBe("already-imported");
    expect(dest.ledger.all()).toHaveLength(1);
    expect(await importedWork(dest)).toHaveLength(6);
    await rejectsWith(receiveLearnerCarriedTransfer(dest.importer, encodeTransfer(pkg), R.ines), "forbidden", /linked to another learner/);
  });

  it("is refused without an admin-confirmed link, or from a district Riverbend has not pinned", async () => {
    const nf = await northfieldExport();
    const network = new TestNetwork();
    const unlinked = riverbend({ pinned: nf.pinned });
    network.route(RIVERBEND_TRANSFER_HOST, (request) => unlinked.endpoint.handle(request));
    await rejectsWith(new DirectTransferChannel({ endpoint: ENDPOINT, fetch: network.fetch }).send(await nf.signed()), "forbidden", /link/);

    const unpinned = riverbend();
    await unpinned.linkLearner(nf.exported.manifest.subject, R.amara);
    network.route(RIVERBEND_TRANSFER_HOST, (request) => unpinned.endpoint.handle(request));
    await rejectsWith(new DirectTransferChannel({ endpoint: ENDPOINT, fetch: network.fetch }).send(await nf.signed()), "forbidden", /pinned/);

    const unsigned: TransferPackage = { archive: nf.exported.bytes, consent: nf.consentFor() };
    await rejectsWith(new DirectTransferChannel({ endpoint: ENDPOINT, fetch: network.fetch }).send(unsigned), "validation-failed", /signed/);
    expect(() => new DirectTransferChannel({ endpoint: `http://${RIVERBEND_TRANSFER_HOST}/`, fetch: network.fetch })).toThrow(/https/);
    expect([...unlinked.ledger.all(), ...unpinned.ledger.all()]).toEqual([]);
  });

  it("lets only a district admin confirm a link, and only to one of the district's students", async () => {
    const nf = await northfieldExport();
    const dest = riverbend();
    await rejectsWith(dest.linkLearner(nf.exported.manifest.subject, R.amara, R.morgan), "forbidden");
    await rejectsWith(dest.linkLearner(nf.exported.manifest.subject, R.morgan), "not-found");
    const link = await dest.linkLearner(nf.exported.manifest.subject, R.amara);
    expect(link).toEqual({
      sourceInstanceLabel: NORTHFIELD_PARTY.label,
      sourcePseudonym: nf.exported.manifest.subject,
      destinationPrincipalId: "prn_rb-student-amara",
      confirmedBy: "prn_rb-district-admin",
    });
    await rejectsWith(dest.linkLearner(nf.exported.manifest.subject, R.ines), "conflict");
  });
});

describe("a learner-carried transfer", () => {
  it("imports a signed file the learner uploads, verified against the pinned key", async () => {
    const nf = await northfieldExport();
    const dest = riverbend({ pinned: nf.pinned });
    const file = await new LearnerCarriedChannel().send(await nf.signed());
    if (file.kind !== "file") throw new Error("expected a file");

    const result = await receiveLearnerCarriedTransfer(dest.importer, file.bytes, R.amara);

    expect(result).toMatchObject({ outcome: "imported", record: { sourceVerification: "verified", channel: "learner-carried" } });
    expect(dest.root.calls).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("flags an unsigned file from an unpinned district as unverified-source, where the district accepts one", async () => {
    const nf = await northfieldExport();
    const unsigned = encodeTransfer({ archive: nf.exported.bytes, consent: nf.consentFor() });

    const accepting = riverbend({ acceptUnverifiedSources: true });
    const result = await receiveLearnerCarriedTransfer(accepting.importer, unsigned, R.amara);
    expect(result.record.sourceVerification).toBe("unverified-source");

    await rejectsWith(receiveLearnerCarriedTransfer(riverbend().importer, unsigned, R.amara), "policy-violation", /pinned/);
    // A file claiming to come from a pinned district must carry its signature.
    await rejectsWith(receiveLearnerCarriedTransfer(riverbend({ pinned: nf.pinned, acceptUnverifiedSources: true }).importer, unsigned, R.amara), "forbidden", /signed/);
  });
});

describe("consent", () => {
  it("is refused once revoked or expired, or for another export or district", async () => {
    const nf = await northfieldExport();
    const dest = riverbend({ pinned: nf.pinned });
    const pkg = await nf.signed();
    const importAs = (consent: TransferConsent, signature = pkg.signature) =>
      dest.importer.importStudentArchive(nf.exported.bytes, signature, consent, { principal: R.amara, channel: "learner-carried" });

    // Revoking leaves the signed grant intact, but the import is refused.
    const revoked = revokeTransferConsent(pkg.consent, nf.source.clock.now);
    expect(await consentGrantDigest(revoked)).toBe(await consentGrantDigest(pkg.consent));
    await rejectsWith(importAs(revoked), "forbidden", /withdrawn/);

    const shortLived = nf.consentFor({ validForDays: 1 });
    const shortPkg = await nf.signed(shortLived);
    dest.clock.now = new Date("2026-10-22T12:00:00Z");
    await rejectsWith(importAs(shortLived, shortPkg.signature), "forbidden", /not in effect/);
    dest.clock.now = new Date("2026-10-21T09:00:00Z");

    const elsewhere = nf.consentFor({ destination: { label: "Lakeside District (synthetic)", instanceId: "ins_lakeside" } as typeof RIVERBEND_PARTY });
    await rejectsWith(importAs(elsewhere, (await nf.signed(elsewhere)).signature), "forbidden", /another district/);

    const other = await nf.source.exporter.exportStudentArchive(P.amara);
    const lenient = riverbend({ acceptUnverifiedSources: true });
    await rejectsWith(lenient.importer.importStudentArchive(other.bytes, undefined, pkg.consent, { principal: R.amara, channel: "learner-carried" }), "forbidden", /another archive/);
    expect(dest.ledger.all()).toEqual([]);

    // And the source will not sign for a consent that is no longer in effect.
    await rejectsWith(nf.signed(revoked), "forbidden");
  });

  it("is given by a guardian for a learner under the district's self-consent age", async () => {
    const nf = await northfieldExport();
    const request = { manifest: nf.exported.manifest, learnerAge: 11, itemClasses: ALL, source: NORTHFIELD_PARTY, destination: RIVERBEND_PARTY, validForDays: 30 };
    expect(() => issueTransferConsent(AGE_POLICY, { ...request, consentedBy: "learner" }, nf.source.clock.now)).toThrow(/guardian/);
    expect(issueTransferConsent(AGE_POLICY, { ...request, consentedBy: "guardian" }, nf.source.clock.now).consentedBy).toBe("guardian");
    expect(() => issueTransferConsent({ selfConsentAge: 18 }, { ...request, learnerAge: 16, consentedBy: "learner" }, nf.source.clock.now)).toThrow(/guardian/);
  });

  it("limits the import to the item classes both the learner and the destination accept", async () => {
    const nf = await northfieldExport();
    const dest = riverbend({ pinned: nf.pinned, acceptedItemClasses: ["artifacts", "feedback", "resources"] });
    const consent = nf.consentFor({ itemClasses: ["artifacts", "submissions", "feedback"] });

    const { record } = await dest.importer.importStudentArchive(nf.exported.bytes, (await nf.signed(consent)).signature, consent, { principal: R.amara, channel: "learner-carried" });

    expect(new Set(record.imported.map((i) => i.itemClass))).toEqual(new Set(["artifacts", "feedback"]));
    expect(record.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemClass: "submissions", reason: "not-accepted-by-district" }),
      expect.objectContaining({ itemClass: "resources", reason: "not-consented" }),
    ]));
    await rejectsWith(
      riverbend({ pinned: nf.pinned, acceptedItemClasses: ["resources"] }).importer.importStudentArchive(nf.exported.bytes, (await nf.signed(consent)).signature, consent, { principal: R.amara, channel: "learner-carried" }),
      "policy-violation",
    );
  });
});

describe("a tampered transfer", () => {
  it("is refused when the archive, the consent or the key does not match the signature", async () => {
    const nf = await northfieldExport();
    const dest = riverbend({ pinned: nf.pinned });
    const pkg = await nf.signed();
    const importAs = (archive: Uint8Array<ArrayBuffer>, consent = pkg.consent, signature = pkg.signature) =>
      dest.importer.importStudentArchive(archive, signature, consent, { principal: R.amara, channel: "learner-carried" });

    // A flipped byte breaks the ZIP or an entry's digest.
    const flipped = nf.exported.bytes.slice();
    flipped[flipped.length >> 1]! ^= 0xff;
    await rejectsWith(importAs(flipped), "validation-failed");

    // A consistent forgery passes validation, but not the signature.
    const forged = await rewrite(nf.exported.bytes, (entries) => {
      const feedback = entries.find((e) => e.path.startsWith("feedback/"))!;
      editJson(entries, feedback.path, (f) => {
        f.body = "Outstanding work, A+.";
      });
    }, { refreshManifest: true });
    await rejectsWith(importAs(forged), "forbidden", /does not cover/);

    // Widening the consent after signing changes the grant the signature covers.
    await rejectsWith(importAs(nf.exported.bytes, { ...pkg.consent, itemClasses: ALL.toReversed() }), "forbidden", /does not cover/);

    // A valid signature by a key Riverbend has not pinned.
    const impostor = await issueTransferPackage(await SigningIdentity.generate(), nf.exported.bytes, pkg.consent, nf.source.clock.now);
    await rejectsWith(importAs(nf.exported.bytes, pkg.consent, impostor.signature), "forbidden", /not valid/);

    // A malformed transfer file.
    expect(() => decodeTransfer(new TextEncoder().encode("{\"format\":\"schoolos.transfer\"}"))).toThrow(/not a SchoolOS transfer/);
    expect(dest.ledger.all()).toEqual([]);
  });
});

/** Imports an unsigned learner-carried rewrite of Amara's archive into a district that accepts unverified sources. */
async function importForgery(edit: Parameters<typeof rewrite>[1]) {
  const nf = await northfieldExport();
  const dest = riverbend({ acceptUnverifiedSources: true });
  const forged = await rewrite(nf.exported.bytes, edit, { refreshManifest: true });
  const result = dest.importer.importStudentArchive(forged, undefined, nf.consentFor(), { principal: R.amara, channel: "learner-carried" });
  return { result, dest };
}

describe("a forged archive", () => {
  it("is refused whole if it carries another learner's work", async () => {
    const { result, dest } = await importForgery((entries) => {
      const artifact = entries.find((e) => e.path.endsWith("artifact.json"))!;
      editJson(entries, artifact.path, (a) => {
        (a.revisions as { author: string }[])[0]!.author = "learner-0000000000000000";
      });
    });
    await rejectsWith(result, "validation-failed", /unknown learner/);
    expect(dest.ledger.all()).toEqual([]);
  });

  it("is refused whole if it carries a teacher-only note", async () => {
    const { result } = await importForgery((entries) => {
      const manifest = entries.find((e) => e.path === "manifest.json")!;
      editJson(entries, manifest.path, (m) => {
        for (const item of m.items as { kind: string; rights: { mode: string } }[]) {
          if (item.kind === "feedback") item.rights = { mode: "export-metadata" };
        }
      });
    });
    await rejectsWith(result, "validation-failed", /rights/);
  });

  it("is refused whole if any text carries a credential", async () => {
    const { result } = await importForgery((entries) => {
      const feedback = entries.find((e) => e.path.startsWith("feedback/"))!;
      editJson(entries, feedback.path, (f) => {
        f.body = "Log in with password=hunter2hunter2 to see your grade.";
      });
    });
    await rejectsWith(result, "validation-failed", /secret-shaped/);
  });

  it("is refused whole if binary content carries a credential, which validation does not screen", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7 AKIAIOSFODNN7EXAMPLE");
    const pdfDigest = await sha256Digest(pdf);
    const { result } = await importForgery((entries) => {
      const artifactEntry = entries.find((e) => e.path.endsWith("artifact.json") && new TextDecoder().decode(e.bytes).includes("Cell membranes essay"))!;
      const contentPath = artifactEntry.path.replace("artifact.json", "r1.md");
      const content = entries.find((e) => e.path === contentPath)!;
      content.bytes = pdf;
      editJson(entries, "manifest.json", (m) => {
        const item = (m.items as { path: string; mediaType: string }[]).find((i) => i.path === contentPath)!;
        item.mediaType = "application/pdf";
      });
      // Keep the record consistent with the new content so only the importer's screen can catch it.
      editJson(entries, artifactEntry.path, (a) => {
        const r1 = (a.revisions as { mediaType: string; digest: string; sizeBytes: number }[])[0]!;
        r1.mediaType = "application/pdf";
        r1.digest = pdfDigest;
        r1.sizeBytes = pdf.byteLength;
      });
    });
    await rejectsWith(result, "validation-failed", /password, key or token/);
  });

  it("is refused whole if any text carries a district ID", async () => {
    const { result } = await importForgery((entries) => {
      const feedback = entries.find((e) => e.path.startsWith("feedback/"))!;
      editJson(entries, feedback.path, (f) => {
        f.body = "Compare with prn_nf-student-elena's lab.";
      });
    });
    await rejectsWith(result, "validation-failed", /district identifiers/);
  });
});
