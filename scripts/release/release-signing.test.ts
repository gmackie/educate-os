// The release pipeline's signing step (scripts/release/release-signing.ts), checked against the
// verifier districts run (@schoolos/releases, as @schoolos/installer calls it). Every key here is
// generated per run; no key material is committed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SigningIdentity } from "../../packages/schoolos-fleet/src/index.ts";
import {
  pinReleaseKeys, RELEASE_INSTALL_GRACE_MS, verifySignedReleaseManifest,
} from "../../packages/schoolos-releases/src/index.ts";
import { sha256Hex } from "./hash-lib.ts";
import {
  migrationNotes, parseSigningArg, RELEASE_SIGNING_KEY_ENV, releaseSigningKey,
  requireSigningOptions, signReleaseManifest, type ReleaseSigningOptions,
} from "./release-signing.ts";

const GOLDEN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "testdata", "golden-manifest.json"));
const NOW = new Date("2026-10-21T00:00:00.000Z");
const OPTIONS = { version: "1.2.0", channel: "stable", now: NOW } as const;

async function keyEnv(identity: SigningIdentity) {
  return { [RELEASE_SIGNING_KEY_ENV]: JSON.stringify(await identity.exportJwk()) };
}

test("a signed manifest verifies against the pinned root key and names the manifest bytes", async () => {
  const identity = await releaseSigningKey(await keyEnv(await SigningIdentity.generate()));
  assert.ok(identity);
  const signed = await signReleaseManifest(GOLDEN, identity, OPTIONS);

  const statement = await verifySignedReleaseManifest(signed, await pinReleaseKeys([identity.publicKey]), { now: NOW });
  assert.equal(statement.manifestSha256, sha256Hex(GOLDEN));
  assert.equal(statement.releaseId, "r000000-fixture");
  assert.equal(statement.version, "1.2.0");
  assert.equal(statement.minimumCompatibleVersion, "1.2.0");
  assert.equal(statement.channel, "stable");
  assert.deepEqual(statement.migrations, []);
  assert.equal(Date.parse(statement.expiresAt) - NOW.getTime(), 90 * 24 * 60 * 60_000);
});

test("a district pinning a different key refuses the statement", async () => {
  const signed = await signReleaseManifest(GOLDEN, await SigningIdentity.generate(), OPTIONS);
  const other = await pinReleaseKeys([(await SigningIdentity.generate()).publicKey]);
  await assert.rejects(verifySignedReleaseManifest(signed, other, { now: NOW }), { code: "unauthenticated" });
});

test("an expired statement is refused once the install grace has passed", async () => {
  const identity = await SigningIdentity.generate();
  const signed = await signReleaseManifest(GOLDEN, identity, { ...OPTIONS, validDays: 1 });
  const trust = await pinReleaseKeys([identity.publicKey]);
  const later = new Date(NOW.getTime() + 24 * 60 * 60_000 + RELEASE_INSTALL_GRACE_MS);
  await assert.rejects(verifySignedReleaseManifest(signed, trust, { now: later, graceMs: RELEASE_INSTALL_GRACE_MS }),
      { code: "unauthenticated" });
});

test("no key means an unsigned development build", async () => {
  assert.equal(await releaseSigningKey({}), undefined);
  assert.equal(await releaseSigningKey({ [RELEASE_SIGNING_KEY_ENV]: "  " }), undefined);
});

test("a malformed key fails without echoing it", async () => {
  const jwk = await (await SigningIdentity.generate()).exportJwk();
  for (const value of [`{"d":"${jwk.d}"`, JSON.stringify({ ...jwk, crv: "P-256" }), jwk.d]) {
    await assert.rejects(releaseSigningKey({ [RELEASE_SIGNING_KEY_ENV]: value }), (error: Error) => {
      assert.match(error.message, /is not an Ed25519 private JWK/);
      assert.ok(!error.message.includes(jwk.d), "the error quoted the private key");
      return true;
    });
  }
});

test("a JWK whose public half belongs to another key is refused before anything is signed", async () => {
  const jwk = await (await SigningIdentity.generate()).exportJwk();
  const other = await (await SigningIdentity.generate()).exportJwk();
  await assert.rejects(releaseSigningKey({ [RELEASE_SIGNING_KEY_ENV]: JSON.stringify({ ...jwk, x: other.x }) }),
      /is not an Ed25519 private JWK/);
});

test("every D1 migration in the release is declared irreversible in the statement", () => {
  const sha256 = "0".repeat(64);
  const migration = (binding: string, id: string) => ({ binding, id, sha256, size: 1, r2Key: `blobs/modules/${sha256}` });
  const notes = migrationNotes({
    workers: {
      "schoolos-ai-guard": { d1Migrations: [migration("LEDGER", "0002_pools"), migration("LEDGER", "0001_init")] },
      "workshop-backend": { d1Migrations: [migration("SCHOOLOS_DB", "0001_init")] },
      router: {},
    } as never,
  });
  assert.deepEqual(notes.map((n) => [n.migrationId, n.irreversible]), [["0001_init", true], ["0002_pools", true]]);
  assert.equal(notes[0]?.summary, "D1 migration on schoolos-ai-guard LEDGER, workshop-backend SCHOOLOS_DB");
});

test("with a key present, the release must say what it is", () => {
  const parsed: Partial<ReleaseSigningOptions> = {};
  const argv = ["--version", "2.0.0", "--channel", "lts", "--valid-days", "30", "--out", "x"];
  assert.equal(parseSigningArg(argv, 0, parsed), 1);
  assert.equal(parseSigningArg(argv, 2, parsed), 3);
  assert.equal(parseSigningArg(argv, 4, parsed), 5);
  assert.equal(parseSigningArg(argv, 6, parsed), undefined);
  assert.deepEqual(requireSigningOptions(parsed), { version: "2.0.0", channel: "lts", validDays: 30 });

  assert.throws(() => requireSigningOptions({ channel: "stable" }), /--version <semver> and --channel/);
  assert.throws(() => requireSigningOptions({ version: "1.0.0", channel: "stable", validDays: 0 }), /--valid-days/);
});
