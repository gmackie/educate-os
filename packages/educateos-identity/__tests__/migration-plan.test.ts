import { describe, expect, it } from "vitest";
import { EducateOsError } from "@educateos/contracts";
import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import { MigrationPlan, planEmailKeyedMigration } from "../src/index.ts";

const id = (c: string) => c.repeat(64);

const USERS = [
  { email: "avery.admin@northfield.example", workshopUserId: id("1") },
  { email: "family.okafor@northfield.example", workshopUserId: id("2") },
  { email: "morgan.lee@teachers.example", workshopUserId: id("3") },
  { email: "former.teacher@northfield.example", workshopUserId: id("4") },
  { email: "  Sam.Rivera@Northfield.example ", workshopUserId: id("5") },
  { email: "riley.chen@northfield.example", workshopUserId: id("6") },
  { email: "Riley.Chen@northfield.example", workshopUserId: id("7") },
  { email: "quinn.okoye@riverbend.example", workshopUserId: id("8") },
  { email: "local-password-user", workshopUserId: id("9") },
];

const plan = (users: readonly unknown[] = USERS) =>
  planEmailKeyedMigration({ directory: NORTHFIELD, otherDirectories: [RIVERBEND], users });

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    return (err as EducateOsError).code;
  }
  return undefined;
}

const entryFor = (workshopUserId: string) => plan().entries.find((e) => e.workshopUserId === workshopUserId)!;

describe("planEmailKeyedMigration", () => {
  it("proposes, but never applies, an adoption when exactly one principal has the email", () => {
    expect(entryFor(id("1"))).toEqual({
      outcome: "exact-single",
      email: "avery.admin@northfield.example",
      workshopUserId: id("1"),
      pendingAdoption: { districtId: "dst_northfield", workshopUserId: id("1"), principalId: "prn_nf-district-admin", requiresAdminConfirmation: true },
    });
  });

  it("matches emails trimmed and case-insensitively, still only as a proposal", () => {
    expect(entryFor(id("5"))).toMatchObject({ outcome: "exact-single", pendingAdoption: { principalId: "prn_nf-teacher-rivera" } });
  });

  it("never links the Okafor siblings' shared family address", () => {
    expect(entryFor(id("2"))).toEqual({
      outcome: "ambiguous",
      email: "family.okafor@northfield.example",
      workshopUserId: id("2"),
      reason: "shared-by-principals",
      candidatePrincipalIds: ["prn_nf-student-amara", "prn_nf-student-chidi"],
    });
  });

  it("never links an email two Workshop users share, such as case variants of one address", () => {
    for (const workshopUserId of [id("6"), id("7")]) {
      expect(entryFor(workshopUserId)).toMatchObject({
        outcome: "ambiguous",
        reason: "shared-by-workshop-users",
        candidatePrincipalIds: ["prn_nf-teacher-chen"],
      });
    }
  });

  it("flags Morgan Lee as cross-district without naming Riverbend's principal", () => {
    const entry = entryFor(id("3"));
    expect(entry).toEqual({
      outcome: "cross-district",
      email: "morgan.lee@teachers.example",
      workshopUserId: id("3"),
      candidatePrincipalIds: ["prn_nf-morgan-lee"],
      otherDistrictIds: ["dst_riverbend"],
    });
    expect(JSON.stringify(entry)).not.toContain("prn_rb-");
  });

  it("flags an email known only in another district as cross-district", () => {
    expect(entryFor(id("8"))).toMatchObject({ outcome: "cross-district", candidatePrincipalIds: [], otherDistrictIds: ["dst_riverbend"] });
  });

  it("leaves addresses and usernames no principal has unmatched", () => {
    expect(entryFor(id("4")).outcome).toBe("unmatched");
    expect(entryFor(id("9")).outcome).toBe("unmatched");
  });

  it("is deterministic, schema-valid and changes no directory", () => {
    const before: unknown = JSON.parse(JSON.stringify(NORTHFIELD));
    const first = plan();
    expect(plan(USERS.toReversed())).toEqual(first);
    expect(MigrationPlan.parse(first)).toEqual(first);
    expect(first.entries.map((e) => e.workshopUserId)).toEqual(USERS.map((u) => u.workshopUserId));
    expect(NORTHFIELD).toEqual(before);
    // Only exact-single entries propose anything, and each awaits confirmation.
    const proposals = first.entries.flatMap((e) => (e.outcome === "exact-single" ? [e.pendingAdoption] : []));
    expect(proposals.map((p) => p.principalId)).toEqual(["prn_nf-district-admin", "prn_nf-teacher-rivera"]);
    expect(proposals.every((p) => p.requiresAdminConfirmation)).toBe(true);
  });

  it("refuses malformed or duplicated input rather than planning around it", () => {
    expect(codeOf(() => plan([...USERS, USERS[0]]))).toBe("validation-failed");
    expect(codeOf(() => plan([{ email: "x@northfield.example", workshopUserId: "not-a-do-id" }]))).toBe("validation-failed");
    expect(codeOf(() => plan([{ ...USERS[0], principalId: "prn_nf-district-admin" }]))).toBe("validation-failed");
    expect(codeOf(() => planEmailKeyedMigration({ directory: NORTHFIELD, otherDirectories: [NORTHFIELD], users: USERS })))
      .toBe("validation-failed");
  });
});
