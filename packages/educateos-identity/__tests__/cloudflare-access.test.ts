import { describe, expect, it } from "vitest";
import { EducateOsError } from "@educateos/contracts";
import {
  accessServiceTokenSubject,
  createDirectoryPrincipalResolver,
  identityFromAccessPayload,
  type VerifiedAccessJwtPayload,
} from "../src/index.ts";
import {
  accessServicePayload,
  accessUserPayload,
  NF_ACCESS,
  NF_SERVICE,
  NF_SERVICE_CLIENT_ID,
  northfieldWithAccess,
  RB_ACCESS,
  riverbendWithAccess,
} from "./helpers.ts";

const nfConfig = { issuer: NF_ACCESS };
const nf = createDirectoryPrincipalResolver(northfieldWithAccess());
const rb = createDirectoryPrincipalResolver(riverbendWithAccess());

/** Sign in to Northfield through Access, the way the kernel seam will. */
const signInNf = (payload: VerifiedAccessJwtPayload) => nf.resolve(identityFromAccessPayload(payload, nfConfig));

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(EducateOsError);
    return (err as EducateOsError).code;
  }
  throw new Error("expected a EducateOsError");
}

describe("identityFromAccessPayload", () => {
  it("takes the subject from Access sub and the issuer from the team domain", () => {
    expect(identityFromAccessPayload(accessUserPayload(NF_ACCESS, "access-uuid-1042"), nfConfig))
      .toEqual({ issuer: NF_ACCESS, subject: "access-uuid-1042", credential: "person" });
  });

  it("rejects a token from another team domain, even one another district trusts", () => {
    expect(codeOf(() => identityFromAccessPayload(accessUserPayload(RB_ACCESS, "access-uuid-1042"), nfConfig)))
      .toBe("unauthenticated");
    expect(codeOf(() => identityFromAccessPayload(accessUserPayload(`${NF_ACCESS}/`, "access-uuid-1042"), nfConfig)))
      .toBe("unauthenticated");
  });

  it.each([
    ["missing", {}],
    ["empty", { sub: "" }],
    ["non-string", { sub: 1042 }],
  ])("rejects a %s sub, even with a valid email", (_, sub) => {
    const payload = { iss: NF_ACCESS, email: "morgan.lee@teachers.example", ...sub };
    expect(codeOf(() => identityFromAccessPayload(payload, nfConfig))).toBe("unauthenticated");
  });

  it("rejects a token that names both a user and a service token", () => {
    const payload = accessUserPayload(NF_ACCESS, "access-uuid-1042", { common_name: NF_SERVICE_CLIENT_ID });
    expect(codeOf(() => identityFromAccessPayload(payload, nfConfig))).toBe("unauthenticated");
  });

  it("maps a service token to a namespaced service credential", () => {
    expect(identityFromAccessPayload(accessServicePayload(NF_ACCESS, NF_SERVICE_CLIENT_ID), nfConfig)).toEqual({
      issuer: NF_ACCESS,
      subject: accessServiceTokenSubject(NF_SERVICE_CLIENT_ID),
      credential: "service",
    });
  });
});

describe("signing in through Cloudflare Access", () => {
  it("resolves by sub and ignores another person's email in the token", async () => {
    const payload = accessUserPayload(NF_ACCESS, "access-uuid-amara", { email: "avery.admin@northfield.example" });
    await expect(signInNf(payload)).resolves.toMatchObject({ principalId: "prn_nf-student-amara", kind: "student" });
  });

  it("denies an unknown sub whatever email it carries, including a shared family address", async () => {
    for (const email of ["family.okafor@northfield.example", "avery.admin@northfield.example"]) {
      await expect(signInNf(accessUserPayload(NF_ACCESS, "access-uuid-new", { email })))
        .rejects.toMatchObject({ code: "unauthenticated" });
    }
  });

  it("keeps the Okafor siblings apart although they share an address", async () => {
    const email = "family.okafor@northfield.example";
    await expect(signInNf(accessUserPayload(NF_ACCESS, "access-uuid-amara", { email })))
      .resolves.toMatchObject({ principalId: "prn_nf-student-amara" });
    await expect(signInNf(accessUserPayload(NF_ACCESS, "access-uuid-chidi", { email })))
      .resolves.toMatchObject({ principalId: "prn_nf-student-chidi" });
  });

  it("ignores forged role and group claims", async () => {
    const payload = accessUserPayload(NF_ACCESS, "access-uuid-chidi", {
      roles: ["district-admin"],
      groups: ["northfield-district-admins"],
      custom: { role: "district-admin" },
    });
    await expect(signInNf(payload)).resolves.toEqual({
      districtId: "dst_northfield",
      principalId: "prn_nf-student-chidi",
      kind: "student",
      identity: { districtId: "dst_northfield", issuer: NF_ACCESS, subject: "access-uuid-chidi" },
    });
  });

  it("resolves Morgan Lee to a different principal per district, with the same sub and email", async () => {
    const email = "morgan.lee@teachers.example";
    const inNorthfield = await signInNf(accessUserPayload(NF_ACCESS, "access-uuid-1042", { email }));
    const inRiverbend = await rb.resolve(
      identityFromAccessPayload(accessUserPayload(RB_ACCESS, "access-uuid-1042", { email }), { issuer: RB_ACCESS }));
    expect(inNorthfield.principalId).toBe("prn_nf-morgan-lee");
    expect(inRiverbend.principalId).toBe("prn_rb-morgan-lee");
  });

  it("does not let Riverbend's team domain sign anyone into Northfield", async () => {
    const riverbendIdentity = identityFromAccessPayload(accessUserPayload(RB_ACCESS, "access-uuid-1042"), { issuer: RB_ACCESS });
    await expect(nf.resolve(riverbendIdentity)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("resolves a service token only through its explicit link to a service principal", async () => {
    await expect(signInNf(accessServicePayload(NF_ACCESS, NF_SERVICE_CLIENT_ID)))
      .resolves.toMatchObject({ principalId: NF_SERVICE, kind: "service" });
    await expect(signInNf(accessServicePayload(NF_ACCESS, "ffffffffffff.access")))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("does not let a person's sub reach a service principal, even one spelled like its link", async () => {
    const lookalike = accessUserPayload(NF_ACCESS, accessServiceTokenSubject(NF_SERVICE_CLIENT_ID));
    await expect(signInNf(lookalike)).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
