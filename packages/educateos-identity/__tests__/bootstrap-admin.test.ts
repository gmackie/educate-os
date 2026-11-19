import { describe, expect, it } from "vitest";
import { checkDirectoryIntegrity, type PrincipalId, type VerifiedIdentity } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { BootstrapAdmin, bootstrapAdminLink, createDirectoryPrincipalResolver, type BootstrapAdminSignIn } from "../src/index.ts";
import { AT, NF_ACCESS, NF_ADMIN, withAccess } from "./helpers.ts";

const FIRST = "prn_nf-first-admin" as PrincipalId;
const RIVERA = "prn_nf-teacher-rivera" as PrincipalId;
const admin: BootstrapAdmin = { principalId: FIRST, displayName: "Quinn First", email: "quinn.first@northfield.example" };

/** Northfield as a fresh install seeds it: Access trusted, the first administrator not yet present. */
const fresh = withAccess(NORTHFIELD, NF_ACCESS, {});
const firstSignIn: VerifiedIdentity = { issuer: NF_ACCESS, subject: "access-uuid-first-admin", credential: "person" };
const signIn: BootstrapAdminSignIn = { identity: firstSignIn, email: admin.email, bootstrapAdmins: [admin] };

describe("bootstrap administrators", () => {
  it("creates the administrator on the first sign-in carrying their email, once", async () => {
    await expect(createDirectoryPrincipalResolver(fresh).resolve(firstSignIn)).rejects.toMatchObject({ code: "unauthenticated" });
    const linked = bootstrapAdminLink(fresh, signIn)!;
    expect(linked.principalId).toBe(FIRST);
    expect(checkDirectoryIntegrity(linked.directory)).toEqual([]);
    const resolved = await createDirectoryPrincipalResolver(linked.directory).resolve(firstSignIn);
    expect(resolved).toMatchObject({ principalId: FIRST });
    expect(linked.directory.principals.find((p) => p.id === FIRST)).toStrictEqual({
      id: FIRST, districtId: fresh.district.id, kind: "staff", status: "active", displayName: admin.displayName, email: admin.email,
      externalIdentities: [{ districtId: fresh.district.id, issuer: NF_ACCESS, subject: firstSignIn.subject }],
    });
    expect(linked.directory.roleAssignments.filter((a) => a.principalId === FIRST)).toStrictEqual([
      { principalId: FIRST, role: "district-admin", scope: { level: "district", districtId: fresh.district.id }, source: "local-grant" },
    ]);
    // The input is untouched, and a second identity with the same email is never linked.
    expect(fresh.principals.some((p) => p.id === FIRST)).toBe(false);
    expect(bootstrapAdminLink(linked.directory, { ...signIn, identity: { ...firstSignIn, subject: "access-uuid-someone-else" } })).toBeUndefined();
  });

  it("matches the email regardless of case and surrounding space", () => {
    expect(bootstrapAdminLink(fresh, { ...signIn, email: "  Quinn.First@Northfield.EXAMPLE " })?.principalId).toBe(FIRST);
  });

  it.each<[string, Partial<BootstrapAdminSignIn>]>([
    ["no email", { email: undefined }],
    ["an empty email", { email: "  " }],
    ["another email", { email: "someone@northfield.example" }],
    ["no configured administrators", { bootstrapAdmins: [] }],
    ["an untrusted issuer", { identity: { ...firstSignIn, issuer: "https://elsewhere.cloudflareaccess.example" } }],
    ["a service credential", { identity: { ...firstSignIn, credential: "service" } }],
  ])("creates nothing for %s", (_, change) => {
    expect(bootstrapAdminLink(fresh, { ...signIn, ...change })).toBeUndefined();
  });

  it("never touches a principal that already exists, whatever its state", () => {
    // Northfield's administrator is already in the directory with an IdP link.
    const existing = { ...admin, principalId: NF_ADMIN, email: "avery.admin@northfield.example" };
    expect(bootstrapAdminLink(fresh, { ...signIn, email: existing.email, bootstrapAdmins: [existing] })).toBeUndefined();
    // Nor one an administrator later deactivated: being created once is the whole allowance.
    const created = bootstrapAdminLink(fresh, signIn)!.directory;
    const deactivated = { ...created, principals: created.principals.map((p) => p.id === FIRST ? { ...p, status: "inactive" as const } : p) };
    expect(bootstrapAdminLink(deactivated, { ...signIn, identity: { ...firstSignIn, subject: "access-uuid-new" } })).toBeUndefined();
  });

  it("refuses an identity already linked to someone else", () => {
    const taken = withAccess(fresh, NF_ACCESS, { [RIVERA]: firstSignIn.subject });
    expect(bootstrapAdminLink(taken, signIn)).toBeUndefined();
  });

  it("creates neither of two administrators sharing the email", () => {
    const twin = { ...admin, principalId: "prn_nf-first-admin-2" as PrincipalId };
    expect(bootstrapAdminLink(fresh, { ...signIn, bootstrapAdmins: [admin, twin] })).toBeUndefined();
  });

  it("validates the configured entry", () => {
    expect(BootstrapAdmin.safeParse(admin).success).toBe(true);
    expect(BootstrapAdmin.safeParse({ ...admin, email: "not-an-email" }).success).toBe(false);
    expect(BootstrapAdmin.safeParse({ ...admin, principalId: "nope" }).success).toBe(false);
    expect(BootstrapAdmin.safeParse({ ...admin, extra: true }).success).toBe(false);
  });
});
