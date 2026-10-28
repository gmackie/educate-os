// The admin's D1 schema holds no personal data beyond its own operators, and the ops private keys
// in it are sealed: unreadable without ADMIN_KEY_ENCRYPTION_KEY, and bound to their row.
import { env } from "cloudflare:test";
import { SigningIdentity } from "@educateos/fleet/ops";
import { describe, expect, it } from "vitest";
import { importKeyEncryptionKey, KeyEncryptionError, openPrivateKey, sealPrivateKey } from "../src/worker/keys.ts";
import { adminDeps, enrolled, FakeDistrict, manualClock, uniqueOrigin } from "./support.ts";

// Column names that suggest personal data. Matched as whole words of the snake_case name.
const PERSONAL = /(^|_)(name|names|first|last|surname|email|emails|mail|phone|phones|mobile|address|addresses|street|postcode|zip|birth|dob|display_name|student|guardian|parent)(_|$)/;
// The one table allowed to hold personal data: the operators of this admin themselves.
const PERSONAL_TABLES = new Set(["operators"]);
// Named like personal data but isn't: a workspace's display name is the district's, not a person's.
const ALLOWED = new Set(["workspaces.display_name"]);

describe("the D1 schema", () => {
  it("has migrations, and they built the tables", () => {
    expect(env.TEST_MIGRATIONS.length).toBeGreaterThan(0);
    expect(env.TEST_MIGRATIONS[0]!.name).toBe("0001_initial.sql");
  });

  it("names no column like personal data outside the operators table", async () => {
    const { results: tables } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
    ).all<{ name: string }>();
    expect(tables.length).toBeGreaterThanOrEqual(5);
    const offending: string[] = [];
    for (const { name: table } of tables) {
      if (PERSONAL_TABLES.has(table)) continue;
      const { results: columns } = await env.DB.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
      for (const { name: column } of columns) {
        if (PERSONAL.test(column) && !ALLOWED.has(`${table}.${column}`)) offending.push(`${table}.${column}`);
      }
    }
    expect(offending).toEqual([]);
  });

  it("catches a column named like personal data (the check itself works)", () => {
    for (const column of ["email", "student_name", "phone", "home_address", "display_name", "guardian_id"]) expect(PERSONAL.test(column), column).toBe(true);
    for (const column of ["workspace_id", "key_id", "time_range", "operator_sub", "aggregates_json"]) expect(PERSONAL.test(column), column).toBe(false);
  });
});

describe("sealed ops keys", () => {
  it("stores the private key encrypted, never as the JWK", async () => {
    const clock = manualClock();
    const district = new FakeDistrict(uniqueOrigin(), clock.now);
    const deps = adminDeps({ now: clock.now });
    const { workspace } = await enrolled(deps, district);
    const row = await env.DB.prepare("SELECT key_id, public_jwk, private_key_ciphertext FROM ops_keys WHERE workspace_id = ?1")
      .bind(workspace.id).first<{ key_id: string; public_jwk: string; private_key_ciphertext: string }>();
    expect(row!.private_key_ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(row!.private_key_ciphertext).not.toContain('"d"');
    expect(JSON.parse(row!.public_jwk)).toEqual({ kty: "OKP", crv: "Ed25519", x: workspace.key!.publicKey, kid: workspace.key!.keyId });
    const kek = await importKeyEncryptionKey(env.ADMIN_KEY_ENCRYPTION_KEY);
    const identity = await openPrivateKey(kek, workspace.id, row!.key_id, row!.private_key_ciphertext);
    expect(identity.keyId).toBe(workspace.key!.keyId);
  });

  it("refuses to open a sealed key with another secret, on another workspace's row, or under another key ID", async () => {
    const kek = await importKeyEncryptionKey(env.ADMIN_KEY_ENCRYPTION_KEY);
    const identity = await SigningIdentity.generate();
    const other = await SigningIdentity.generate();
    const sealed = await sealPrivateKey(kek, "wks_one", identity);
    const wrongKek = await importKeyEncryptionKey(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""));
    await expect(openPrivateKey(wrongKek, "wks_one", identity.keyId, sealed)).rejects.toBeInstanceOf(KeyEncryptionError);
    await expect(openPrivateKey(kek, "wks_two", identity.keyId, sealed)).rejects.toBeInstanceOf(KeyEncryptionError);
    await expect(openPrivateKey(kek, "wks_one", other.keyId, sealed)).rejects.toBeInstanceOf(KeyEncryptionError);
    await expect(openPrivateKey(kek, "wks_one", identity.keyId, sealed.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).rejects.toBeInstanceOf(KeyEncryptionError);
    expect((await openPrivateKey(kek, "wks_one", identity.keyId, sealed)).keyId).toBe(identity.keyId);
  });

  it("refuses a missing or short encryption key", async () => {
    await expect(importKeyEncryptionKey(undefined)).rejects.toThrow("32 bytes");
    await expect(importKeyEncryptionKey("c2hvcnQ")).rejects.toThrow("32 bytes");
    await expect(importKeyEncryptionKey("not base64url!")).rejects.toThrow("base64url");
  });
});
