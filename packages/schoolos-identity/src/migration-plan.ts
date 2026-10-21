import { z } from "zod";
import { DistrictId, PrincipalId, SchoolOsError, type DistrictDirectorySnapshot } from "@schoolos/contracts";
import { WorkshopUserId } from "./workshop-user.ts";

/**
 * An existing Workshop user as the kernel keys it today: by the email (or, for password accounts,
 * the username) its `UserDurableObject` was named from.
 */
export const EmailKeyedWorkshopUser = z.strictObject({
  email: z.string().min(1).max(320),
  workshopUserId: WorkshopUserId,
});
/** An email-keyed Workshop user. */
export type EmailKeyedWorkshopUser = z.infer<typeof EmailKeyedWorkshopUser>;

/**
 * A proposal to adopt an existing Workshop user's data into a principal. It is never applied
 * automatically: `requiresAdminConfirmation` is always `true`, and the kernel seam records the
 * administrator's decision.
 */
export const PendingWorkshopUserAdoption = z.strictObject({
  districtId: DistrictId,
  workshopUserId: WorkshopUserId,
  principalId: PrincipalId,
  requiresAdminConfirmation: z.literal(true),
});
/** A pending Workshop user adoption. */
export type PendingWorkshopUserAdoption = z.infer<typeof PendingWorkshopUserAdoption>;

/**
 * What the plan says about one Workshop user. Outcomes are exclusive and checked in this order:
 *
 * 1. `ambiguous`: several principals in the district, or several Workshop users, share the email
 *    (for example siblings with a family address). Never linked; an administrator must sort it out.
 * 2. `cross-district`: the email also belongs to a principal in another district (for example a
 *    teacher who works in two). Never linked, even if one local principal matches, because the
 *    Workshop user may hold either person's data. Other districts' principals are not named.
 * 3. `exact-single`: exactly one principal has the email. Produces a pending adoption.
 * 4. `unmatched`: no principal anywhere has the email.
 */
export const MigrationPlanEntry = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("exact-single"),
    email: z.string(),
    workshopUserId: WorkshopUserId,
    pendingAdoption: PendingWorkshopUserAdoption,
  }),
  z.strictObject({
    outcome: z.literal("ambiguous"),
    email: z.string(),
    workshopUserId: WorkshopUserId,
    reason: z.enum(["shared-by-principals", "shared-by-workshop-users"]),
    /** The district's principals with this email, sorted. */
    candidatePrincipalIds: z.array(PrincipalId),
  }),
  z.strictObject({
    outcome: z.literal("cross-district"),
    email: z.string(),
    workshopUserId: WorkshopUserId,
    /** The district's own principals with this email, sorted. At most one. */
    candidatePrincipalIds: z.array(PrincipalId),
    /** The other districts holding a principal with this email, sorted. */
    otherDistrictIds: z.array(DistrictId),
  }),
  z.strictObject({
    outcome: z.literal("unmatched"),
    email: z.string(),
    workshopUserId: WorkshopUserId,
  }),
]);
/** One entry of a migration plan. */
export type MigrationPlanEntry = z.infer<typeof MigrationPlanEntry>;

/** The migration plan for one district. Entries are sorted by `workshopUserId`. */
export const MigrationPlan = z.strictObject({
  districtId: DistrictId,
  entries: z.array(MigrationPlanEntry),
});
/** A migration plan. */
export type MigrationPlan = z.infer<typeof MigrationPlan>;

/** What {@link planEmailKeyedMigration} plans from. */
export interface MigrationPlanInput {
  /** The district being migrated into. */
  directory: DistrictDirectorySnapshot;
  /** Every other district's directory the deployment can see, for the cross-district check. */
  otherDirectories: readonly DistrictDirectorySnapshot[];
  /** The deployment's existing email-keyed Workshop users. */
  users: readonly unknown[];
}

/**
 * Emails are compared trimmed and lower-cased. That is only for *finding candidates*: a match
 * never links anything by itself, and an administrator confirms each adoption.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function principalsByEmail(directory: DistrictDirectorySnapshot): Map<string, PrincipalId[]> {
  const index = new Map<string, PrincipalId[]>();
  for (const principal of directory.principals) {
    if (principal.email === undefined) continue;
    const key = normalizeEmail(principal.email);
    index.set(key, [...(index.get(key) ?? []), principal.id]);
  }
  for (const ids of index.values()) ids.sort(byString);
  return index;
}

/**
 * Plans how a district adopts the deployment's existing email-keyed Workshop users. The plan is a
 * pure function of its input (the same users in any order give the same plan), changes no
 * directory, and merges nothing: its only proposals are pending adoptions for `exact-single`
 * entries, each of which an administrator must confirm.
 *
 * Throws `SchoolOsError("validation-failed")` for a malformed user, a Workshop user listed twice,
 * or an `otherDirectories` entry that is the district itself.
 */
export function planEmailKeyedMigration(input: MigrationPlanInput): MigrationPlan {
  const districtId = input.directory.district.id;
  if (input.otherDirectories.some((d) => d.district.id === districtId)) {
    throw new SchoolOsError("validation-failed", "The other directories include the district being migrated.");
  }
  const parsedUsers = z.array(EmailKeyedWorkshopUser).safeParse(input.users);
  if (!parsedUsers.success) throw new SchoolOsError("validation-failed", "A Workshop user record is malformed.");
  const users = parsedUsers.data;
  if (new Set(users.map((u) => u.workshopUserId)).size !== users.length) {
    throw new SchoolOsError("validation-failed", "A Workshop user is listed more than once.");
  }

  const local = principalsByEmail(input.directory);
  const elsewhere = input.otherDirectories.map((d) => ({ districtId: d.district.id, emails: principalsByEmail(d) }));
  const usersPerEmail = new Map<string, number>();
  for (const user of users) {
    const key = normalizeEmail(user.email);
    usersPerEmail.set(key, (usersPerEmail.get(key) ?? 0) + 1);
  }

  const entries = users.toSorted((a, b) => byString(a.workshopUserId, b.workshopUserId)).map((user): MigrationPlanEntry => {
    const { email, workshopUserId } = user;
    const key = normalizeEmail(email);
    const candidatePrincipalIds = local.get(key) ?? [];
    const otherDistrictIds = elsewhere.filter((d) => d.emails.has(key)).map((d) => d.districtId).toSorted(byString);

    if (candidatePrincipalIds.length > 1) {
      return { outcome: "ambiguous", email, workshopUserId, reason: "shared-by-principals", candidatePrincipalIds };
    }
    if ((usersPerEmail.get(key) ?? 0) > 1) {
      return { outcome: "ambiguous", email, workshopUserId, reason: "shared-by-workshop-users", candidatePrincipalIds };
    }
    if (otherDistrictIds.length > 0) {
      return { outcome: "cross-district", email, workshopUserId, candidatePrincipalIds, otherDistrictIds };
    }
    const [principalId] = candidatePrincipalIds;
    if (principalId === undefined) return { outcome: "unmatched", email, workshopUserId };
    return {
      outcome: "exact-single",
      email,
      workshopUserId,
      pendingAdoption: { districtId, workshopUserId, principalId, requiresAdminConfirmation: true },
    };
  });

  return { districtId, entries };
}
