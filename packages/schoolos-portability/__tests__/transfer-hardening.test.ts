import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchoolOsError } from "@schoolos/contracts";
import { signEnvelope, SigningIdentity, type SignedEnvelope } from "@schoolos/fleet";
import {
  acceptConsentRevocationNotice,
  ConsentRevocationChannel,
  encodeTransfer,
  issueConsentRevocationNotice,
  issueTransferConsent,
  issueTransferPackage,
  LearnerCarriedChannel,
  receiveLearnerCarriedTransfer,
  revokeTransferConsent,
  type TransferConsent,
  type TransferItemClass,
} from "../src/index.ts";
import { amarasYear } from "./scenario.ts";
import { editJson, P, rejectsWith, rewrite, setup } from "./setup.ts";
import { NORTHFIELD_PARTY, R, riverbend, RIVERBEND_PARTY, RIVERBEND_REVOCATION_HOST, TestNetwork } from "./transfer-setup.ts";

const ALL: TransferItemClass[] = ["artifacts", "submissions", "feedback", "resources"];
const REVOCATIONS = `https://${RIVERBEND_REVOCATION_HOST}/api/transfers/revocations`;

/** Amara's export from Northfield and the Northfield agent identity that signs for it. */
async function northfield() {
  const source = setup();
  await amarasYear(source);
  const exported = await source.exporter.exportStudentArchive(P.amara);
  const identity = await SigningIdentity.generate();
  const consentFor = (validForDays = 30): TransferConsent => issueTransferConsent({ selfConsentAge: 13 }, {
    manifest: exported.manifest,
    learnerAge: 16,
    consentedBy: "learner",
    itemClasses: ALL,
    source: NORTHFIELD_PARTY,
    destination: RIVERBEND_PARTY,
    validForDays,
  }, source.clock.now);
  const signed = (consent = consentFor()) => issueTransferPackage(identity, exported.bytes, consent, source.clock.now);
  return { source, exported, identity, consentFor, signed, pinned: [{ ...NORTHFIELD_PARTY, publicKey: identity.publicKey }] };
}

/** The artifacts in Amara's Riverbend personal workspace. */
async function amarasWork(dest: ReturnType<typeof riverbend>) {
  const personal = await dest.workspaces.ensurePersonalWorkspace(R.amara);
  return dest.artifacts.listArtifacts(R.amara, personal.id);
}

let globalFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  globalFetch = vi.fn(async () => {
    throw new Error("global fetch used");
  });
  vi.stubGlobal("fetch", globalFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transfer signatures, made with the fleet agent identity", () => {
  it("refuses a signature of another message kind, even over the same statement", async () => {
    const nf = await northfield();
    const dest = riverbend({ pinned: nf.pinned });
    const pkg = await nf.signed();
    // The same statement, signed by the pinned key, but as a revocation notice.
    const wrongKind = await signEnvelope(nf.identity, "consent-revocation", pkg.signature!.payload);

    await rejectsWith(dest.importer.importStudentArchive(pkg.archive, wrongKind, pkg.consent, { principal: R.amara, channel: "learner-carried" }), "forbidden", /not valid/);
    // And a transfer signature is not a revocation notice.
    await rejectsWith(acceptConsentRevocationNotice({ self: RIVERBEND_PARTY, pinnedSources: nf.pinned, revocations: dest.revocations }, pkg.signature), "validation-failed");
    expect(dest.ledger.all()).toEqual([]);
  });

  it("refuses a forged statement and a signature the payload was swapped under", async () => {
    const nf = await northfield();
    const dest = riverbend({ pinned: nf.pinned });
    const pkg = await nf.signed();
    const importWith = (signature: SignedEnvelope) =>
      dest.importer.importStudentArchive(pkg.archive, signature, pkg.consent, { principal: R.amara, channel: "learner-carried" });

    const swapped: SignedEnvelope = { ...pkg.signature!, payload: { ...(pkg.signature!.payload as Record<string, unknown>), issuedAt: "2026-10-21T00:00:00.000Z" } };
    await rejectsWith(importWith(swapped), "forbidden", /not valid/);

    // A forger's own key, presented under the pinned key's ID.
    const forger = await issueTransferPackage(await SigningIdentity.generate(), pkg.archive, pkg.consent, nf.source.clock.now);
    await rejectsWith(importWith({ ...forger.signature!, keyId: nf.identity.keyId }), "forbidden", /not valid/);
    expect(dest.ledger.all()).toEqual([]);
  });

  it("refuses an expired consent under a valid signature, and a signature stretched past its expiry", async () => {
    const nf = await northfield();
    const dest = riverbend({ pinned: nf.pinned });
    const consent = nf.consentFor(1);
    const pkg = await nf.signed(consent);
    const importAs = (c: TransferConsent) => dest.importer.importStudentArchive(pkg.archive, pkg.signature, c, { principal: R.amara, channel: "learner-carried" });

    dest.clock.now = new Date("2026-10-22T12:00:01Z");
    await rejectsWith(importAs(consent), "forbidden", /not in effect/);
    // Extending the expiry changes the grant the signature covers.
    await rejectsWith(importAs({ ...consent, expiresAt: "2026-12-31T00:00:00.000Z" }), "forbidden", /does not cover/);
    expect(dest.ledger.all()).toEqual([]);
  });
});

describe("consent revocation notices", () => {
  it("stop a learner-carried file downloaded before the revocation from being imported", async () => {
    const nf = await northfield();
    const dest = riverbend({ pinned: nf.pinned });
    const network = new TestNetwork();
    network.route(RIVERBEND_REVOCATION_HOST, (request) => dest.revocationEndpoint.handle(request));
    const pkg = await nf.signed();
    const file = await new LearnerCarriedChannel().send(pkg);
    if (file.kind !== "file") throw new Error("expected a file");

    // The learner withdraws consent at Northfield, which tells Riverbend directly.
    const revoked = revokeTransferConsent(pkg.consent, nf.source.clock.now);
    await new ConsentRevocationChannel({ endpoint: REVOCATIONS, fetch: network.fetch }).send(await issueConsentRevocationNotice(nf.identity, revoked));

    // The file still carries the consent as it was, unrevoked, and its signature is still valid.
    await rejectsWith(receiveLearnerCarriedTransfer(dest.importer, file.bytes, R.amara), "forbidden", /withdrawn/);
    expect(await amarasWork(dest)).toEqual([]);
    expect(dest.ledger.all()).toEqual([]);
    expect(network.requests).toEqual([REVOCATIONS]);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("are recorded only when signed by the source's pinned key, for this district", async () => {
    const nf = await northfield();
    const dest = riverbend({ pinned: nf.pinned });
    const network = new TestNetwork();
    network.route(RIVERBEND_REVOCATION_HOST, (request) => dest.revocationEndpoint.handle(request));
    const channel = new ConsentRevocationChannel({ endpoint: REVOCATIONS, fetch: network.fetch });
    const revoked = revokeTransferConsent(nf.consentFor(), nf.source.clock.now);

    // Another district's key cannot revoke a Northfield consent, even one Riverbend also pins.
    const lakeside = await SigningIdentity.generate();
    const both = riverbend({ pinned: [...nf.pinned, { label: "Lakeside District (synthetic)", instanceId: "ins_lakeside", publicKey: lakeside.publicKey } as (typeof nf.pinned)[number]] });
    network.route(RIVERBEND_REVOCATION_HOST, (request) => both.revocationEndpoint.handle(request));
    await rejectsWith(channel.send(await issueConsentRevocationNotice(lakeside, revoked)), "forbidden", /not valid/);

    // A notice whose payload was edited after signing.
    network.route(RIVERBEND_REVOCATION_HOST, (request) => dest.revocationEndpoint.handle(request));
    const notice = await issueConsentRevocationNotice(nf.identity, revoked);
    const edited = { ...notice, payload: { ...(notice.payload as Record<string, unknown>), consentId: "0".repeat(32) } };
    await rejectsWith(channel.send(edited), "forbidden", /not valid/);

    // A district Riverbend has not pinned cannot revoke at all.
    const unpinned = riverbend();
    network.route(RIVERBEND_REVOCATION_HOST, (request) => unpinned.revocationEndpoint.handle(request));
    await rejectsWith(channel.send(notice), "forbidden", /pinned/);

    // A notice for a consent to another district.
    const elsewhere = revokeTransferConsent(issueTransferConsent({ selfConsentAge: 13 }, {
      manifest: nf.exported.manifest, learnerAge: 16, consentedBy: "learner", itemClasses: ALL, source: NORTHFIELD_PARTY,
      destination: { label: "Lakeside District (synthetic)", instanceId: "ins_lakeside" } as typeof RIVERBEND_PARTY, validForDays: 30,
    }, nf.source.clock.now), nf.source.clock.now);
    network.route(RIVERBEND_REVOCATION_HOST, (request) => dest.revocationEndpoint.handle(request));
    await rejectsWith(channel.send(await issueConsentRevocationNotice(nf.identity, elsewhere)), "forbidden", /another district/);

    for (const district of [dest, both, unpinned]) expect(await district.revocations.find(NORTHFIELD_PARTY, revoked.id)).toBeUndefined();

    // The genuine notice is recorded, and only a revoked consent has one.
    await channel.send(notice);
    expect(await dest.revocations.find(NORTHFIELD_PARTY, revoked.id)).toMatchObject({ consentId: revoked.id, revokedAt: revoked.revokedAt });
    await rejectsWith(issueConsentRevocationNotice(nf.identity, nf.consentFor()), "validation-failed", /revoked/);
  });
});

describe("an import", () => {
  it("that fails part-way through leaves nothing behind, and can be retried", async () => {
    const nf = await northfield();
    const dest = riverbend({ pinned: nf.pinned, contentWritesBeforeFailure: 3 });
    const pkg = await nf.signed();
    const upload = () => receiveLearnerCarriedTransfer(dest.importer, encodeTransfer(pkg), R.amara);

    await expect(upload()).rejects.toThrow(/content storage is unavailable/);
    expect(await amarasWork(dest)).toEqual([]);
    expect((await dest.records.load()).state).toMatchObject({ artifacts: [], revisions: [] });
    expect(dest.ledger.all()).toEqual([]);

    dest.content.writesBeforeFailure = Infinity;
    const { outcome, record } = await upload();
    expect(outcome).toBe("imported");
    expect(await amarasWork(dest)).toHaveLength(record.imported.length);
  });

  it("whose commit fails stores nothing", async () => {
    const nf = await northfield();
    const dest = riverbend({ pinned: nf.pinned });
    const pkg = await nf.signed();
    const commit = dest.records.commit.bind(dest.records);
    let failures = 0;
    dest.records.commit = async () => {
      // The workspace directory commits separately; fail only the artifacts' commit, every time.
      failures++;
      throw new SchoolOsError("unavailable", "the artifact records are unavailable");
    };

    await rejectsWith(receiveLearnerCarriedTransfer(dest.importer, encodeTransfer(pkg), R.amara), "unavailable");
    expect(failures).toBe(1);
    dest.records.commit = commit;
    expect((await dest.records.load()).state.artifacts).toEqual([]);
    expect(dest.ledger.all()).toEqual([]);
  });

  it("that cannot be recorded keeps its reservation, so the archive is never imported twice", async () => {
    const nf = await northfield();
    const dest = riverbend({ pinned: nf.pinned });
    const pkg = await nf.signed();
    dest.ledger.complete = async () => {
      throw new SchoolOsError("unavailable", "the ledger is unavailable");
    };

    await rejectsWith(receiveLearnerCarriedTransfer(dest.importer, encodeTransfer(pkg), R.amara), "unavailable");
    const created = (await amarasWork(dest)).length;
    expect(created).toBeGreaterThan(0);
    await rejectsWith(receiveLearnerCarriedTransfer(dest.importer, encodeTransfer(pkg), R.amara), "conflict", /already being imported/);
    expect(await amarasWork(dest)).toHaveLength(created);
  });

  it("marks every revision it creates as imported", async () => {
    const nf = await northfield();
    const dest = riverbend({ pinned: nf.pinned });
    const pkg = await nf.signed();
    await receiveLearnerCarriedTransfer(dest.importer, encodeTransfer(pkg), R.amara);

    const { state } = await dest.records.load();
    expect(state.revisions.length).toBeGreaterThan(state.artifacts.length);
    expect(new Set(state.revisions.map((r) => r.provenance.origin))).toEqual(new Set(["imported"]));
  });

  it("keeps where a teacher's feedback pointed in the learner's work", async () => {
    const nf = await northfield();
    const dest = riverbend({ acceptUnverifiedSources: true });
    const anchored = await rewrite(nf.exported.bytes, (entries) => {
      const feedback = entries.find((e) => e.path.startsWith("feedback/"))!;
      editJson(entries, feedback.path, (f) => {
        f.anchor = { part: 1, region: { kind: "text-range", start: 0, end: 7 } };
      });
    }, { refreshManifest: true });

    await dest.importer.importStudentArchive(anchored, undefined, nf.consentFor(), { principal: R.amara, channel: "learner-carried" });

    const feedback = (await amarasWork(dest)).find((v) => v.artifact.title.startsWith("Feedback"))!;
    const { content } = await dest.artifacts.readRevision(R.amara, feedback.artifact.id);
    expect(content).toMatchObject({ kind: "text", text: expect.stringContaining("On part 1, characters 1 to 7.") });
  });
});
