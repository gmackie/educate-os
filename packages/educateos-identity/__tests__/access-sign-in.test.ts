import { describe, expect, it, vi } from "vitest";
import { EducateOsError } from "@educateos/contracts";
import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import {
  accessServiceTokenSubject,
  approveIdentityLink,
  createAccessSignInResolver,
  matchEmailKeyedUsers,
  planEmailKeyedMigration,
  type PendingIdentityLink,
} from "../src/index.ts";
import { AT, NF_ACCESS, NF_ADMIN, NF_SERVICE_CLIENT_ID, RB_ACCESS, northfieldWithAccess } from "./helpers.ts";

const id = (c: string) => c.repeat(64);
const USERS = [
  { email: "  Sam.Rivera@Northfield.example ", workshopUserId: id("5") },
  { email: "family.okafor@northfield.example", workshopUserId: id("2") },
];

function migrationFor(directory = northfieldWithAccess()) {
  const recorded: PendingIdentityLink[] = [];
  return {
    recorded,
    migration: {
      plan: planEmailKeyedMigration({ directory, otherDirectories: [RIVERBEND], users: USERS }),
      recordPendingLink: vi.fn(async (link: PendingIdentityLink) => {
        recorded.push(link);
      }),
    },
  };
}

const resolverFor = (options: Partial<Parameters<typeof createAccessSignInResolver>[0]> = {}) =>
  createAccessSignInResolver({ directory: northfieldWithAccess(), access: { issuer: NF_ACCESS }, ...options });

describe("createAccessSignInResolver", () => {
  it("resolves a linked Access subject to its principal, whatever the email says", async () => {
    const resolved = await resolverFor().resolveAccessSignIn(
      { issuer: NF_ACCESS, subject: "access-uuid-1042", email: "family.okafor@northfield.example" });
    expect(resolved).toEqual({ outcome: "resolved", principalId: "prn_nf-morgan-lee", displayName: expect.any(String) });
  });

  it.each(["inactive", "graduated"] as const)("refuses a %s principal even with a linked subject and migration email", async (status) => {
    const directory = northfieldWithAccess();
    directory.principals = directory.principals.map((p) =>
      p.id === "prn_nf-morgan-lee" ? { ...p, status } : p);
    const { migration, recorded } = migrationFor(directory);
    expect(await resolverFor({ directory, migration }).resolveAccessSignIn({
      issuer: NF_ACCESS, subject: "access-uuid-1042", email: "sam.rivera@northfield.example",
    })).toEqual({ outcome: "unauthenticated" });
    expect(recorded).toEqual([]);
  });

  it("refuses another team's issuer, even for a subject linked here", async () => {
    expect(await resolverFor().resolveAccessSignIn({ issuer: RB_ACCESS, subject: "access-uuid-1042" }))
      .toEqual({ outcome: "unauthenticated" });
  });

  it("never resolves a person's sign-in to a service principal", async () => {
    const subject = accessServiceTokenSubject(NF_SERVICE_CLIENT_ID);
    expect(await resolverFor().resolveAccessSignIn({ issuer: NF_ACCESS, subject }))
      .toEqual({ outcome: "unauthenticated" });
  });

  it("refuses malformed requests rather than reading them", async () => {
    const resolver = resolverFor();
    for (const request of [
      null,
      { issuer: NF_ACCESS },
      { issuer: NF_ACCESS, subject: "" },
      { issuer: NF_ACCESS, subject: "access-uuid-1042", roles: ["district-admin"] },
    ]) {
      expect(await resolver.resolveAccessSignIn(request)).toEqual({ outcome: "unauthenticated" });
    }
  });

  it("records a pending link for an exact-single adoption and refuses until it is approved", async () => {
    const { migration, recorded } = migrationFor();
    const signIn = { issuer: NF_ACCESS, subject: "access-uuid-rivera", email: "sam.rivera@northfield.example" };

    expect(await resolverFor({ migration }).resolveAccessSignIn(signIn)).toEqual({ outcome: "adoption-pending" });
    expect(recorded).toEqual([{
      districtId: "dst_northfield",
      principalId: "prn_nf-teacher-rivera",
      identity: { districtId: "dst_northfield", issuer: NF_ACCESS, subject: "access-uuid-rivera" },
      credential: "person",
      requestedAt: expect.any(String),
      workshopUserId: id("5"),
    }]);

    // Approval links the identity, but does not transfer the existing Workshop data.
    const { directory } = approveIdentityLink(northfieldWithAccess(), recorded[0]!, { actorId: NF_ADMIN, decidedAt: AT });
    for (const email of [signIn.email, "renamed@northfield.example", undefined]) {
      expect(await resolverFor({ directory, migration }).resolveAccessSignIn({ ...signIn, email }))
        .toEqual({ outcome: "adoption-pending" });
    }
    // The migration owner removes the entry only after verified adoption of the old data.
    const completed = { ...migration, plan: { ...migration.plan, entries: [] } };
    expect(await resolverFor({ directory, migration: completed }).resolveAccessSignIn(signIn))
      .toMatchObject({ outcome: "resolved", principalId: "prn_nf-teacher-rivera" });
  });

  it("refuses without recording anything when the email is ambiguous or no migration runs", async () => {
    const { migration, recorded } = migrationFor();
    const okafor = { issuer: NF_ACCESS, subject: "access-uuid-new", email: "family.okafor@northfield.example" };
    expect(await resolverFor({ migration }).resolveAccessSignIn(okafor)).toEqual({ outcome: "unauthenticated" });
    const rivera = { ...okafor, email: "sam.rivera@northfield.example" };
    expect(await resolverFor().resolveAccessSignIn(rivera)).toEqual({ outcome: "unauthenticated" });
    expect(await resolverFor({ migration }).resolveAccessSignIn({ ...rivera, issuer: RB_ACCESS }))
      .toEqual({ outcome: "unauthenticated" });
    expect(recorded).toEqual([]);
  });

  it("fails closed when the pending link cannot be recorded", async () => {
    const { migration } = migrationFor();
    migration.recordPendingLink.mockRejectedValue(new Error("storage unavailable"));
    await expect(resolverFor({ migration }).resolveAccessSignIn(
      { issuer: NF_ACCESS, subject: "access-uuid-rivera", email: "sam.rivera@northfield.example" },
    )).rejects.toThrow("storage unavailable");
  });

  it("rejects another district's migration plan", () => {
    const { migration } = migrationFor();
    const plan = planEmailKeyedMigration({ directory: RIVERBEND, otherDirectories: [NORTHFIELD], users: [] });
    expect(() => resolverFor({ migration: { ...migration, plan } })).toThrow(EducateOsError);
  });
});

// SCHO-259: what the kernel's one-time principal migration asks the district.
describe("matchEmailKeyedUsers", () => {
  it("names a principal only for an email exactly one person has", () => {
    const matches = matchEmailKeyedUsers(NORTHFIELD, [
      ...USERS,
      { email: "nobody@northfield.example", workshopUserId: id("7") },
    ]);
    expect(matches).toStrictEqual([
      { email: "family.okafor@northfield.example", outcome: "ambiguous" },
      { email: "  Sam.Rivera@Northfield.example ", outcome: "exact-single", principalId: "prn_nf-teacher-rivera" },
      { email: "nobody@northfield.example", outcome: "unmatched" },
    ]);
  });

  it("refuses malformed and repeated users", () => {
    expect(() => matchEmailKeyedUsers(NORTHFIELD, [{ email: "a@b.example", workshopUserId: "not-hex" }])).toThrow(EducateOsError);
    expect(() => matchEmailKeyedUsers(NORTHFIELD, [USERS[0], USERS[0]])).toThrow(EducateOsError);
  });
});
