import { describe, expect, it } from "vitest";
import { checkDirectoryIntegrity, SchoolOsError, type PrincipalId, type VerifiedIdentity, type WorkshopUserId } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import {
  approveIdentityLink,
  createDirectoryPrincipalResolver,
  IdentityLinkAuditEvent,
  rejectIdentityLink,
  requestIdentityLink,
} from "../src/index.ts";
import { AT, NF_ACCESS, NF_ADMIN, NF_IDP, RB_ADMIN, withAccess } from "./helpers.ts";

/** Northfield after enabling Access, before anyone has an Access link. */
const directory = withAccess(NORTHFIELD, NF_ACCESS, {});
const MORGAN = "prn_nf-morgan-lee" as PrincipalId;
const RIVERA = "prn_nf-teacher-rivera" as PrincipalId;
const morganAccess: VerifiedIdentity = { issuer: NF_ACCESS, subject: "access-uuid-1042", credential: "person" };
const decision = { actorId: NF_ADMIN, decidedAt: AT };

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(SchoolOsError);
    return (err as SchoolOsError).code;
  }
  throw new Error("expected a SchoolOsError");
}

describe("identity linking", () => {
  it("links a new identity only once an administrator approves, producing an intact directory", async () => {
    const pending = requestIdentityLink(directory, { principalId: MORGAN, identity: morganAccess, requestedAt: AT });

    // The request alone changes nothing: the identity still resolves to no one.
    await expect(createDirectoryPrincipalResolver(directory).resolve(morganAccess))
      .rejects.toMatchObject({ code: "unauthenticated" });

    const { directory: next, event } = approveIdentityLink(directory, pending, decision);
    expect(checkDirectoryIntegrity(next)).toEqual([]);
    await expect(createDirectoryPrincipalResolver(next).resolve(morganAccess)).resolves.toMatchObject({ principalId: MORGAN });
    // The original link survives, and the input snapshot is untouched.
    await expect(createDirectoryPrincipalResolver(next).resolve({ issuer: NF_IDP, subject: "user-1042", credential: "person" }))
      .resolves.toMatchObject({ principalId: MORGAN });
    expect(directory.principals.find((p) => p.id === MORGAN)!.externalIdentities).toHaveLength(1);

    expect(event).toEqual({
      districtId: "dst_northfield",
      actor: { principalId: NF_ADMIN },
      action: "identity-link.approved",
      target: { principalId: MORGAN, identity: { districtId: "dst_northfield", issuer: NF_ACCESS, subject: "access-uuid-1042" } },
      at: AT,
    });
  });

  it("keeps email out of audit events", () => {
    const pending = requestIdentityLink(directory, { principalId: MORGAN, identity: morganAccess, requestedAt: AT });
    const events = [approveIdentityLink(directory, pending, decision).event, rejectIdentityLink(directory, pending, decision)];
    for (const event of events) {
      expect(JSON.stringify(event)).not.toMatch(/@/);
      // The schema is strict, so an email field cannot be added to an event that is then stored.
      expect(IdentityLinkAuditEvent.safeParse({ ...event, email: "morgan.lee@teachers.example" }).success).toBe(false);
    }
  });

  it("refuses to link an identity that is already another principal's", () => {
    // Rivera's IdP identity cannot be moved onto Morgan.
    const stolen: VerifiedIdentity = { issuer: NF_IDP, subject: "nf-0101", credential: "person" };
    expect(codeOf(() => requestIdentityLink(directory, { principalId: MORGAN, identity: stolen, requestedAt: AT }))).toBe("conflict");
  });

  it("refuses at approval an identity someone else was linked to while the request waited", () => {
    const forMorgan = requestIdentityLink(directory, { principalId: MORGAN, identity: morganAccess, requestedAt: AT });
    const forRivera = requestIdentityLink(directory, { principalId: RIVERA, identity: morganAccess, requestedAt: AT });
    const { directory: afterRivera } = approveIdentityLink(directory, forRivera, decision);
    expect(codeOf(() => approveIdentityLink(afterRivera, forMorgan, decision))).toBe("conflict");
  });

  it("refuses an identity that is already linked to the same principal", () => {
    const pending = requestIdentityLink(directory, { principalId: MORGAN, identity: morganAccess, requestedAt: AT });
    const { directory: next } = approveIdentityLink(directory, pending, decision);
    expect(codeOf(() => approveIdentityLink(next, pending, decision))).toBe("conflict");
  });

  it("refuses links from issuers the district does not trust", () => {
    const untrusted: VerifiedIdentity = { issuer: "https://riverbend.cloudflareaccess.example", subject: "access-uuid-1042", credential: "person" };
    expect(codeOf(() => requestIdentityLink(directory, { principalId: MORGAN, identity: untrusted, requestedAt: AT }))).toBe("forbidden");
    // Nor can a pending link be edited to name one after it was requested.
    const pending = requestIdentityLink(directory, { principalId: MORGAN, identity: morganAccess, requestedAt: AT });
    const edited = { ...pending, identity: { ...pending.identity, issuer: untrusted.issuer } };
    expect(codeOf(() => approveIdentityLink(directory, edited, decision))).toBe("forbidden");
  });

  it("refuses to link a service credential to a person, or a person's to a service", () => {
    const service: VerifiedIdentity = { issuer: NF_ACCESS, subject: "service-token:0a1b2c3d4e5f.access", credential: "service" };
    expect(codeOf(() => requestIdentityLink(directory, { principalId: MORGAN, identity: service, requestedAt: AT })))
      .toBe("validation-failed");
  });

  it("refuses unknown principals and pending links from another district", () => {
    expect(codeOf(() => requestIdentityLink(directory, { principalId: "prn_nf-nobody" as PrincipalId, identity: morganAccess, requestedAt: AT })))
      .toBe("not-found");
    const pending = requestIdentityLink(directory, { principalId: MORGAN, identity: morganAccess, requestedAt: AT });
    const foreign = { ...pending, districtId: "dst_riverbend" };
    expect(codeOf(() => approveIdentityLink(directory, foreign as typeof pending, decision))).toBe("not-found");
  });

  it("lets only a district administrator of this district decide", () => {
    const pending = requestIdentityLink(directory, { principalId: MORGAN, identity: morganAccess, requestedAt: AT });
    for (const actorId of [MORGAN, "prn_nf-principal-high" as PrincipalId, RB_ADMIN]) {
      expect(codeOf(() => approveIdentityLink(directory, pending, { actorId, decidedAt: AT }))).toBe("forbidden");
      expect(codeOf(() => rejectIdentityLink(directory, pending, { actorId, decidedAt: AT }))).toBe("forbidden");
    }
  });

  it("rejects a malformed pending link or decision", () => {
    const pending = requestIdentityLink(directory, { principalId: MORGAN, identity: morganAccess, requestedAt: AT });
    expect(codeOf(() => approveIdentityLink(directory, { ...pending, roles: ["district-admin"] } as typeof pending, decision)))
      .toBe("validation-failed");
    expect(codeOf(() => approveIdentityLink(directory, pending, { ...decision, decidedAt: "yesterday" }))).toBe("validation-failed");
  });

  it("carries the migrating Workshop user on the pending link", () => {
    const workshopUserId = "a".repeat(64) as WorkshopUserId;
    expect(requestIdentityLink(directory, { principalId: MORGAN, identity: morganAccess, requestedAt: AT, workshopUserId }))
      .toMatchObject({ workshopUserId, credential: "person" });
  });
});
