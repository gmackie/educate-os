// The Workshop's principal resolver (SCHO-259): the `DistrictPrincipalResolver` entrypoint over a
// real service binding, answering from the district's directory as the district's own sign-in does.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { ACCESS_ISSUER } from "./fixtures.ts";

const subjectOf = (principalId: string) =>
  NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
const hex = (c: string) => c.repeat(64);

describe("DistrictPrincipalResolver", () => {
  it("resolves a linked Access subject to the district's principal, whatever the email says", async () => {
    const rivera = { issuer: ACCESS_ISSUER, subject: subjectOf("prn_nf-teacher-rivera") };
    await expect(env.PRINCIPALS.resolveAccessSignIn(rivera))
      .resolves.toStrictEqual({ outcome: "resolved", principalId: "prn_nf-teacher-rivera", displayName: "Sam Rivera" });
    await expect(env.PRINCIPALS.resolveAccessSignIn({ ...rivera, email: "avery.admin@northfield.example" }))
      .resolves.toMatchObject({ principalId: "prn_nf-teacher-rivera" });
  });

  it("refuses a subject the school has not set up, and an untrusted issuer", async () => {
    await expect(env.PRINCIPALS.resolveAccessSignIn({ issuer: ACCESS_ISSUER, subject: "nobody", email: "sam.rivera@northfield.example" }))
      .resolves.toStrictEqual({ outcome: "unauthenticated" });
    await expect(env.PRINCIPALS.resolveAccessSignIn({ issuer: "https://other.example", subject: subjectOf("prn_nf-teacher-rivera") }))
      .resolves.toStrictEqual({ outcome: "unauthenticated" });
  });

  it("matches email-keyed Workshop users to one person each, or to no one", async () => {
    await expect(env.PRINCIPALS.matchEmailKeyedUsers([
      { email: "sam.rivera@northfield.example", workshopUserId: hex("1") },
      { email: "family.okafor@northfield.example", workshopUserId: hex("2") },
      { email: "stranger@elsewhere.example", workshopUserId: hex("3") },
    ])).resolves.toStrictEqual([
      { email: "sam.rivera@northfield.example", outcome: "exact-single", principalId: "prn_nf-teacher-rivera" },
      { email: "family.okafor@northfield.example", outcome: "ambiguous" },
      { email: "stranger@elsewhere.example", outcome: "unmatched" },
    ]);
  });
});
