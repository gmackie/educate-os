import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { ACCESS_ISSUER } from "./fixtures.ts";

const person = NORTHFIELD.principals.find(p => p.id === "prn_nf-student-amara")!;
const signIn = { issuer: ACCESS_ISSUER, subject: person.externalIdentities[0]!.subject };
const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);

// Change the real stored row, leaving the already-running application intact. This tests that
// login reads the directory again rather than retaining the seed or a cached identity index.
async function changePerson(change: Record<string, unknown>) {
  await runInDurableObject(district(), (_instance, state) => {
    const row = state.storage.sql.exec<{ record_json: string }>(
      "SELECT record_json FROM academic_principals WHERE id = ?", person.id,
    ).one();
    state.storage.sql.exec("UPDATE academic_principals SET record_json = ? WHERE id = ?",
      JSON.stringify({ ...JSON.parse(row.record_json), ...change }), person.id);
  });
}

afterEach(async () => { await changePerson(person); });

describe("DistrictPrincipalResolver over real workerd service RPC and SQLite", () => {
  it("returns only principal identity and survives restart and email changes", async () => {
    const expected = { outcome: "resolved", principalId: person.id, displayName: person.displayName };
    expect(await env.PRINCIPALS.resolveAccessSignIn({ ...signIn, email: "old@example.test" })).toEqual(expected);
    await evictDurableObject(district());
    expect(await env.PRINCIPALS.resolveAccessSignIn({ ...signIn, email: "new@example.test" })).toEqual(expected);
  });

  it("refuses unknown issuers, cross-district subjects and mismatched token subjects despite matching email", async () => {
    for (const attempt of [
      { ...signIn, issuer: "https://other.cloudflareaccess.com" },
      { ...signIn, subject: "another-district-student" },
      { ...signIn, subject: "wrong-token-sub", email: "amara@northfield.example" },
    ]) expect(await env.PRINCIPALS.resolveAccessSignIn(attempt)).toEqual({ outcome: "unauthenticated" });
  });

  it.each(["inactive", "graduated"])("refuses a %s principal on the next login", async status => {
    expect((await env.PRINCIPALS.resolveAccessSignIn(signIn)).outcome).toBe("resolved");
    await changePerson({ status });
    expect(await env.PRINCIPALS.resolveAccessSignIn(signIn)).toEqual({ outcome: "unauthenticated" });
  });

  it("honors revoked identity links without an object restart or an email fallback", async () => {
    expect((await env.PRINCIPALS.resolveAccessSignIn(signIn)).outcome).toBe("resolved");
    await changePerson({ externalIdentities: [] });
    expect(await env.PRINCIPALS.resolveAccessSignIn({ ...signIn, email: "amara@northfield.example" })).toEqual({ outcome: "unauthenticated" });
  });

  it("refuses malformed cross-district stored links rather than leaking directory records", async () => {
    await env.PRINCIPALS.resolveAccessSignIn(signIn);
    await changePerson({ externalIdentities: person.externalIdentities.map(i => ({ ...i, districtId: "dst_other" })) });
    expect(await env.PRINCIPALS.resolveAccessSignIn(signIn)).toEqual({ outcome: "unauthenticated" });
  });
});

// SCHO-309: what the Workshop re-asks while a principal holds live sessions or execution.
describe("DistrictPrincipalResolver.principalStanding", () => {
  it.each(["inactive", "graduated"])("answers inactive for a %s principal without a restart", async status => {
    expect(await env.PRINCIPALS.principalStanding(person.id)).toEqual({ outcome: "active" });
    await changePerson({ status });
    expect(await env.PRINCIPALS.principalStanding(person.id)).toEqual({ outcome: "inactive" });
  });

  it("answers inactive for unknown and malformed principals", async () => {
    for (const id of ["prn_nf-missing", "principal:" + person.id, "", "prn_rb-district-admin"]) {
      expect(await env.PRINCIPALS.principalStanding(id)).toEqual({ outcome: "inactive" });
    }
  });
});
