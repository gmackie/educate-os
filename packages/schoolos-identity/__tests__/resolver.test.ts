import { describe, expect, it } from "vitest";
import { SchoolOsError, type VerifiedIdentity } from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { createDirectoryPrincipalResolver } from "../src/index.ts";
import { NF_IDP, RB_IDP } from "./helpers.ts";

const nf = createDirectoryPrincipalResolver(NORTHFIELD);
const rb = createDirectoryPrincipalResolver(RIVERBEND);

const person = (issuer: string, subject: string): VerifiedIdentity => ({ issuer, subject, credential: "person" });

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SchoolOsError);
    return (err as SchoolOsError).code;
  }
  throw new Error("expected a rejection");
}

describe("createDirectoryPrincipalResolver", () => {
  it("maps a trusted (issuer, subject) to its principal", async () => {
    await expect(nf.resolve(person(NF_IDP, "nf-0101"))).resolves.toEqual({
      districtId: "dst_northfield",
      principalId: "prn_nf-teacher-rivera",
      kind: "staff",
      identity: { districtId: "dst_northfield", issuer: NF_IDP, subject: "nf-0101" },
    });
  });

  it("resolves Morgan Lee to a different principal in each district", async () => {
    const inNorthfield = await nf.resolve(person(NF_IDP, "user-1042"));
    const inRiverbend = await rb.resolve(person(RB_IDP, "user-1042"));
    expect(inNorthfield.principalId).toBe("prn_nf-morgan-lee");
    expect(inRiverbend.principalId).toBe("prn_rb-morgan-lee");
  });

  it("rejects an issuer the district does not trust, even with a subject it knows", async () => {
    // Riverbend's IdP vouching for Morgan's shared subject must not sign anyone into Northfield.
    expect(await rejection(nf.resolve(person(RB_IDP, "user-1042")))).toBe("unauthenticated");
    expect(await rejection(nf.resolve(person("https://evil.example", "nf-0001")))).toBe("unauthenticated");
  });

  it("rejects a subject no principal is linked to", async () => {
    expect(await rejection(nf.resolve(person(NF_IDP, "nf-9999")))).toBe("unauthenticated");
  });

  it("compares subjects exactly, never case-insensitively or trimmed", async () => {
    expect(await rejection(nf.resolve(person(NF_IDP, "USER-1042")))).toBe("unauthenticated");
    expect(await rejection(nf.resolve(person(NF_IDP, "user-1042 ")))).toBe("unauthenticated");
  });

  it("ignores email, role and group claims, including forged ones", async () => {
    const forged = {
      ...person(NF_IDP, "nf-s-2005"),
      email: "avery.admin@northfield.example",
      roles: ["district-admin"],
      groups: ["northfield-admins"],
      principalId: "prn_nf-district-admin",
    } as VerifiedIdentity;
    await expect(nf.resolve(forged)).resolves.toMatchObject({ principalId: "prn_nf-student-felix", kind: "student" });
  });

  it("never resolves by email: the Okafor siblings' shared address selects nobody", async () => {
    const byEmailOnly = { ...person(NF_IDP, "family.okafor@northfield.example") };
    expect(await rejection(nf.resolve(byEmailOnly))).toBe("unauthenticated");
    await expect(nf.resolve(person(NF_IDP, "nf-s-2001"))).resolves.toMatchObject({ principalId: "prn_nf-student-amara" });
    await expect(nf.resolve(person(NF_IDP, "nf-s-2002"))).resolves.toMatchObject({ principalId: "prn_nf-student-chidi" });
  });

  it("refuses to resolve a person's link for a service credential", async () => {
    expect(await rejection(nf.resolve({ issuer: NF_IDP, subject: "nf-0001", credential: "service" }))).toBe("unauthenticated");
  });

  it("rejects malformed input as unauthenticated rather than throwing a parse error", async () => {
    expect(await rejection(nf.resolve(person(NF_IDP, "")))).toBe("unauthenticated");
    expect(await rejection(nf.resolve({ issuer: "http://idp.northfield.example", subject: "nf-0001", credential: "person" })))
      .toBe("unauthenticated");
  });

  it("refuses to serve a directory in which two principals share a link", () => {
    const amara = NORTHFIELD.principals.find((p) => p.id === "prn_nf-student-amara")!;
    const corrupt = {
      ...NORTHFIELD,
      principals: NORTHFIELD.principals.map((p) =>
        p.id === "prn_nf-student-chidi" ? { ...p, externalIdentities: amara.externalIdentities } : p),
    };
    expect(() => createDirectoryPrincipalResolver(corrupt)).toThrow(SchoolOsError);
  });
});
