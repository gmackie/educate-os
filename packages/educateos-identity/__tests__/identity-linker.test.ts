import { describe, expect, it } from "vitest";
import { checkDirectoryIntegrity, EducateOsError, type PrincipalId, type VerifiedIdentity, type WorkshopUserId } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import {
  approveIdentityLink,
  createDirectoryPrincipalResolver,
  IdentityLinkAuditEvent,
  rejectIdentityLink,
  requestIdentityLink,
  requestNewPrincipalLink,
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
    expect(err).toBeInstanceOf(EducateOsError);
    return (err as EducateOsError).code;
  }
  throw new Error("expected a EducateOsError");
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

  it("refuses a decision made outside the administrator's dated role (ADR-0012)", () => {
    const pending = requestIdentityLink(directory, { principalId: MORGAN, identity: morganAccess, requestedAt: AT });
    const dated = (dates: { validFrom?: string; validUntil?: string }) => ({
      ...directory,
      roleAssignments: directory.roleAssignments.map((a) => (a.principalId === NF_ADMIN && a.role === "district-admin" ? { ...a, ...dates } : a)),
    });
    const at = Date.parse(AT);
    const expired = dated({ validUntil: new Date(at).toISOString() });
    const notYet = dated({ validFrom: new Date(at + 1000).toISOString() });
    for (const snapshot of [expired, notYet]) {
      expect(codeOf(() => approveIdentityLink(snapshot, pending, decision))).toBe("forbidden");
      expect(codeOf(() => rejectIdentityLink(snapshot, pending, decision))).toBe("forbidden");
    }
    expect(() => approveIdentityLink(dated({ validFrom: new Date(at).toISOString() }), pending, decision)).not.toThrow();
  });

  it("links a guardian as a person: through a person credential an administrator approves, never a service one", () => {
    const guardian = "prn_nf-guardian-gina" as PrincipalId;
    const withGuardian = {
      ...directory,
      principals: [...directory.principals, {
        id: guardian,
        districtId: directory.district.id,
        kind: "guardian" as const,
        status: "active" as const,
        displayName: "Gina Okafor",
        externalIdentities: [{ districtId: directory.district.id, issuer: NF_IDP, subject: "gina-idp" }],
      }],
    };
    const ginaAccess: VerifiedIdentity = { issuer: NF_ACCESS, subject: "access-uuid-gina", credential: "person" };
    const pending = requestIdentityLink(withGuardian, { principalId: guardian, identity: ginaAccess, requestedAt: AT });
    expect(approveIdentityLink(withGuardian, pending, decision).directory.principals.find((p) => p.id === guardian)?.externalIdentities).toHaveLength(2);
    expect(codeOf(() => requestIdentityLink(withGuardian, { principalId: guardian, identity: { ...ginaAccess, credential: "service" }, requestedAt: AT })))
      .toBe("validation-failed");
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

  it("creates a guardian principal from its first approved link, and nothing before (ADR-0012)", async () => {
    const guardian = "prn_g-new-guardian" as PrincipalId;
    const ginaAccess: VerifiedIdentity = { issuer: NF_ACCESS, subject: "access-uuid-gina", credential: "person" };
    const pending = requestNewPrincipalLink(directory, {
      principalId: guardian,
      newPrincipal: { kind: "guardian", displayName: "Gina Okafor" },
      identity: ginaAccess,
      requestedAt: AT,
    });
    expect(directory.principals.some((p) => p.id === guardian)).toBe(false);
    await expect(createDirectoryPrincipalResolver(directory).resolve(ginaAccess)).rejects.toMatchObject({ code: "unauthenticated" });

    const { directory: next, event } = approveIdentityLink(directory, pending, decision);
    expect(checkDirectoryIntegrity(next)).toEqual([]);
    expect(next.principals.find((p) => p.id === guardian)).toEqual({
      id: guardian,
      districtId: "dst_northfield",
      kind: "guardian",
      status: "active",
      displayName: "Gina Okafor",
      externalIdentities: [{ districtId: "dst_northfield", issuer: NF_ACCESS, subject: "access-uuid-gina" }],
    });
    await expect(createDirectoryPrincipalResolver(next).resolve(ginaAccess)).resolves.toMatchObject({ principalId: guardian, kind: "guardian" });
    expect(event.target.principalId).toBe(guardian);

    // Approving again, or creating over a principal that exists, takes nothing over.
    expect(codeOf(() => approveIdentityLink(next, pending, decision))).toBe("conflict");
    expect(codeOf(() => requestNewPrincipalLink(directory, {
      principalId: MORGAN,
      newPrincipal: { kind: "guardian", displayName: "Not Morgan" },
      identity: ginaAccess,
      requestedAt: AT,
    }))).toBe("conflict");
    // A service credential never becomes a guardian, and only a guardian is ever created.
    expect(codeOf(() => requestNewPrincipalLink(directory, {
      principalId: guardian,
      newPrincipal: { kind: "guardian", displayName: "Gina Okafor" },
      identity: { ...ginaAccess, credential: "service" },
      requestedAt: AT,
    }))).toBe("validation-failed");
    expect(codeOf(() => requestNewPrincipalLink(directory, {
      principalId: guardian,
      newPrincipal: { kind: "staff", displayName: "Gina Okafor" } as never,
      identity: ginaAccess,
      requestedAt: AT,
    }))).toBe("validation-failed");
  });
});
