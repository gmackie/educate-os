// SCHO-232: a learner may still hold a transfer file made before the EducateOS rename: its wire
// format, transfer statement, archive manifest and provenance carry `schoolos.*` names, and the
// statement is signed in the fleet's legacy context. It still validates, verifies and imports.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SigningIdentity, canonicalJson, toBase64Url } from "@educateos/fleet";
import { sha256Digest } from "@educateos/learning-artifacts";
import { consentGrantDigest, issueTransferConsent, receiveLearnerCarriedTransfer, validateArchive } from "../src/index.ts";
import { amarasYear } from "./scenario.ts";
import { editJson, P, rewrite, setup } from "./setup.ts";
import { NORTHFIELD_PARTY, R, riverbend, RIVERBEND_PARTY } from "./transfer-setup.ts";

let globalFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  globalFetch = vi.fn(async () => new Response("no network in tests", { status: 599 }));
  vi.stubGlobal("fetch", globalFetch);
});
afterEach(() => vi.unstubAllGlobals());

/** Amara's archive as the code before the rename wrote it. */
async function legacyExport() {
  const source = setup();
  await amarasYear(source);
  const exported = await source.exporter.exportStudentArchive(P.amara);
  const archive = await rewrite(exported.bytes, (entries) => {
    editJson(entries, "provenance.json", (provenance) => {
      provenance.format = "schoolos.student-archive.provenance";
      provenance.generator = "@schoolos/portability";
    });
    editJson(entries, "manifest.json", (manifest) => {
      manifest.format = "schoolos.student-archive";
    });
  }, { refreshManifest: true });
  return { source, exported, archive };
}

describe("a transfer made before the EducateOS rename", () => {
  it("validates as an archive, keeping the names it was written with", async () => {
    const { archive } = await legacyExport();
    const validated = await validateArchive(archive);
    expect(validated.manifest.format).toBe("schoolos.student-archive");
    expect(validated.provenance).toMatchObject({ format: "schoolos.student-archive.provenance", generator: "@schoolos/portability" });
  });

  it("verifies against the pinned key and imports, from a learner-carried file", async () => {
    const { source, exported, archive } = await legacyExport();
    const identity = await SigningIdentity.generate();
    const consent = issueTransferConsent({ selfConsentAge: 13 }, {
      manifest: exported.manifest,
      learnerAge: 16,
      consentedBy: "learner",
      itemClasses: ["artifacts", "submissions", "feedback", "resources"],
      source: NORTHFIELD_PARTY,
      destination: RIVERBEND_PARTY,
      validForDays: 30,
    }, source.clock.now);
    const statement = {
      format: "schoolos.transfer-statement",
      formatVersion: 1,
      archiveDigest: await sha256Digest(archive),
      exportId: exported.manifest.exportId,
      subject: exported.manifest.subject,
      consentId: consent.id,
      consentDigest: await consentGrantDigest(consent),
      source: consent.source,
      destination: consent.destination,
      issuedAt: source.clock.now.toISOString(),
    };
    // Signed as `signEnvelope` signed before the rename.
    const signedBytes = new TextEncoder().encode(`schoolos-fleet/v1\0student-transfer\0${canonicalJson(statement)}`);
    const signature = { payload: JSON.parse(canonicalJson(statement)), signature: await identity.sign(signedBytes), keyId: identity.keyId };
    const file = new TextEncoder().encode(JSON.stringify({ format: "schoolos.transfer", formatVersion: 1, archive: toBase64Url(archive), consent, signature }));

    const dest = riverbend({ pinned: [{ ...NORTHFIELD_PARTY, publicKey: identity.publicKey }] });
    await dest.linkLearner(exported.manifest.subject, R.amara);
    const result = await receiveLearnerCarriedTransfer(dest.importer, file, R.amara);
    expect(result).toMatchObject({ outcome: "imported", record: { sourceVerification: "verified", channel: "learner-carried" } });
  });
});
