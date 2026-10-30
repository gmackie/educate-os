// What the EducateOS AI call guard may learn from the district about whom a model call is for
// (SCHO-132). It is a narrow read model over the district's own records, separate from the `/api`
// surface: no browser reaches it, and nothing a caller sends says what role or grade a user has.

import { z } from "zod";
import { GradeBand, roleAssignmentInForce, EducateOsError, SchoolRole, type DistrictDirectorySnapshot, type PrincipalId } from "@educateos/contracts";
import { createWorkshopUserResolver, WorkshopUserKey, type WorkshopUserLink, type WorkshopUserPrincipal } from "@educateos/identity";
import type { Workspace } from "@educateos/workspaces";
import { AiPrincipal, AiWorkspaceContext } from "@educateos/ai-governance";

/** Whom the guard asks about: the kernel-authenticated Workshop user, and the workspace of the call. */
export const GuardSubjectRequest = z.strictObject({
  /** The Workshop user the kernel authenticated (`AiCallDescriptor.initiator.id`). */
  workshopUser: WorkshopUserKey,
  /** The Workshop workspace (gadget) the call belongs to, when it belongs to one. */
  gadgetId: z.string().min(1).max(256).optional(),
});
/** A guard subject request. */
export type GuardSubjectRequest = z.input<typeof GuardSubjectRequest>;

/**
 * Whom the guard asks about once a call is admitted: the principal and workspace its reservation
 * records, which the guard itself resolved from the Workshop user when it admitted the call.
 */
export const AdmittedSubjectRequest = z.strictObject({
  /** The principal the call was admitted for. */
  principal: AiPrincipal,
  /** The workspace the call is billed to. */
  workspace: AiWorkspaceContext,
});
/** An admitted subject request. */
export type AdmittedSubjectRequest = z.input<typeof AdmittedSubjectRequest>;

/**
 * What the district says about a Workshop user, for the guard: who they are, what they hold, and
 * which workspace and grade bands a call of theirs belongs to. Labels only, never learner data.
 */
export const GuardSubject = z.strictObject({
  /** The principal the call is billed to. */
  principal: AiPrincipal,
  /** A student or a member of staff. Service principals are never Workshop users. */
  kind: z.enum(["student", "staff"]),
  /** Every role the principal holds anywhere in the district, sorted, for audit and display. */
  roles: z.array(SchoolRole),
  /** The workspace the call is billed to. */
  workspace: AiWorkspaceContext,
  /**
   * The grade bands the call's content is for, as the district publishes them: a course
   * workspace's course, else the student's active courses, else their schools. Empty for staff,
   * and for a student the directory places nowhere (the guard then assumes the youngest).
   */
  gradeBands: z.array(GradeBand),
});
/** A guard subject. */
export type GuardSubject = z.infer<typeof GuardSubject>;

/**
 * The guard's read of the district. `null` means the Workshop user is no active principal of this
 * district, or the workspace they named is someone else's: the guard refuses the call.
 */
export interface GuardDirectory {
  /** What the district says about `request`'s Workshop user, or `null`. */
  guardSubject(request: GuardSubjectRequest): Promise<GuardSubject | null>;
  /**
   * What the district says now about the principal of a call already admitted, or `null` when
   * they are no longer an active principal of this district. Used to screen the call's output.
   */
  admittedSubject(request: AdmittedSubjectRequest): Promise<GuardSubject | null>;
  /**
   * The directory the guard's ledger resolves funding against, with each principal's profile
   * (display name, email) stripped: `ledgerDirectory` of the current snapshot.
   */
  ledgerDirectory(): Promise<DistrictDirectorySnapshot>;
}

/** The district records a {@link GuardSubject} is derived from. */
export interface GuardDirectorySource {
  /** The academic directory. */
  directory: DistrictDirectorySnapshot;
  /** The district's workspaces; a course workspace is found by its Workshop storage handle. */
  workspaces: readonly Workspace[];
  /** Administrator-confirmed Workshop user links. */
  workshopUserLinks: readonly WorkshopUserLink[];
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const unique = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].toSorted(byString);

/**
 * Derives the {@link GuardSubject} of `request` from the district's records, or `null`. The
 * Workshop user reaches a principal through a confirmed link (`@educateos/identity`), or, when the
 * Workshop names them by principal (`principal:<id>`), as that principal; the
 * principal's kind, roles and grade bands come from the directory, and a gadget's workspace from
 * the workspace whose Workshop storage handle names it. A gadget with no workspace record is the
 * owner's personal workspace; one whose workspace belongs to another principal is refused. A
 * principal that is not `active` (inactive or graduated) holds no grants, so it has no subject.
 */
export function guardSubjectFrom(source: GuardDirectorySource, input: GuardSubjectRequest): GuardSubject | null {
  const parsed = GuardSubjectRequest.safeParse(input);
  if (!parsed.success) return null;
  const request = parsed.data;
  const { directory } = source;
  let resolved: WorkshopUserPrincipal | undefined;
  try {
    resolved = createWorkshopUserResolver(directory, source.workshopUserLinks).resolve(request.workshopUser);
  } catch (error) {
    if (!(error instanceof EducateOsError && error.code === "unauthenticated")) throw error;
    resolved = principalKeyed(directory, request.workshopUser);
  }
  if (resolved === undefined) return null;
  // Only students and staff draw on district AI funding; a guardian or service has no subject.
  const { kind } = resolved;
  if (kind !== "student" && kind !== "staff") return null;
  if (!isActive(directory, resolved.principalId)) return null;

  const workspaceRecord = request.gadgetId === undefined
    ? undefined
    : source.workspaces.find((w) => w.districtId === directory.district.id && w.storageHandle?.backend === "workshop" && w.storageHandle.ref === request.gadgetId);
  if (workspaceRecord !== undefined && workspaceRecord.ownerPrincipalId !== resolved.principalId) return null;
  const workspace: AiWorkspaceContext = workspaceRecord?.kind === "course" ? { kind: "course", offeringId: workspaceRecord.offeringId } : { kind: "personal" };
  return subjectOf(directory, resolved.principalId, kind, workspace);
}

/** The Workshop's name for a user it signed in through the district's principal resolver. */
export const PRINCIPAL_WORKSHOP_USER_PREFIX = "principal:";

/**
 * The principal a principal-keyed Workshop user is (SCHO-283). With `PRINCIPAL_RESOLVER` bound, the
 * Workshop names a user `principal:<id>` only after this district resolved their verified Access
 * sign-in to that principal (`resolveAccessSignIn`), so the key is the district's own answer, not a
 * claim: no administrator link is needed. Email-keyed users the principal migration aliased keep
 * their email key and still need a confirmed {@link WorkshopUserLink}.
 */
function principalKeyed(directory: DistrictDirectorySnapshot, workshopUser: string): WorkshopUserPrincipal | undefined {
  if (!workshopUser.startsWith(PRINCIPAL_WORKSHOP_USER_PREFIX)) return undefined;
  const principalId = workshopUser.slice(PRINCIPAL_WORKSHOP_USER_PREFIX.length);
  const principal = directory.principals.find((p) => p.id === principalId);
  if (principal === undefined || principal.kind === "service") return undefined;
  return { districtId: directory.district.id, principalId: principal.id, kind: principal.kind };
}

/**
 * Derives the {@link GuardSubject} of an admitted call's principal from the district's records, or
 * `null` when they are not an active student or member of staff of this district. The workspace is
 * the one the call was admitted for and is not re-checked; the principal's kind, roles and grade
 * bands are read afresh, as for {@link guardSubjectFrom}.
 */
export function admittedSubjectFrom(source: GuardDirectorySource, input: AdmittedSubjectRequest): GuardSubject | null {
  const parsed = AdmittedSubjectRequest.safeParse(input);
  if (!parsed.success) return null;
  const { principal, workspace } = parsed.data;
  const { directory } = source;
  if (principal.districtId !== directory.district.id) return null;
  const kind = directory.principals.find((p) => p.id === principal.principalId)?.kind;
  if ((kind !== "student" && kind !== "staff") || !isActive(directory, principal.principalId)) return null;
  return subjectOf(directory, principal.principalId, kind, workspace);
}

// Only an active principal holds grants (`PrincipalStatus`); district AI funding is one. An
// inactive or graduated principal keeps its link and its work, but its calls are refused.
function isActive(directory: DistrictDirectorySnapshot, principalId: PrincipalId): boolean {
  return directory.principals.find((p) => p.id === principalId)?.status === "active";
}

function subjectOf(directory: DistrictDirectorySnapshot, principalId: PrincipalId, kind: "student" | "staff", workspace: AiWorkspaceContext): GuardSubject {
  return {
    principal: { principalId, districtId: directory.district.id },
    kind,
    roles: unique(directory.roleAssignments.filter((a) => a.principalId === principalId && roleAssignmentInForce(a, new Date())).map((a) => a.role)),
    workspace,
    gradeBands: kind === "student" ? studentGradeBands(directory, principalId, workspace) : [],
  };
}

function studentGradeBands(directory: DistrictDirectorySnapshot, principalId: PrincipalId, workspace: AiWorkspaceContext): GradeBand[] {
  const courseBand = (offeringId: string) => {
    const offering = directory.offerings.find((o) => o.id === offeringId);
    return directory.courses.find((c) => c.id === offering?.courseId)?.gradeBand;
  };
  if (workspace.kind === "course") {
    const band = courseBand(workspace.offeringId);
    if (band !== undefined) return [band];
  }
  const enrollments = directory.enrollments.filter((e) => e.principalId === principalId && e.role === "student");
  const active = unique(enrollments.filter((e) => e.status === "active").flatMap((e) => courseBand(e.offeringId) ?? []));
  if (active.length > 0) return active;
  const schoolIds = new Set([
    ...enrollments.flatMap((e) => directory.offerings.find((o) => o.id === e.offeringId)?.schoolId ?? []),
    ...directory.roleAssignments.flatMap((a) => (a.principalId === principalId && a.scope.level !== "district" ? [a.scope.schoolId] : [])),
  ]);
  return unique(directory.schools.filter((s) => schoolIds.has(s.id)).flatMap((s) => s.gradeBands));
}

/**
 * `directory` with nothing about a principal but their ID, kind, lifecycle status and identity
 * links: every display name becomes the principal's ID, and emails are dropped. Funding decisions
 * need no profile, so none leaves the district for them.
 */
export function ledgerDirectory(directory: DistrictDirectorySnapshot): DistrictDirectorySnapshot {
  return {
    ...directory,
    principals: directory.principals.map(({ id, districtId, kind, status, externalIdentities }) => ({ id, districtId, kind, status, displayName: id, externalIdentities })),
  };
}

/** A {@link GuardDirectory} reading the district's records afresh for every request. */
export function guardDirectoryOver(load: () => Promise<GuardDirectorySource>): GuardDirectory {
  return {
    async guardSubject(request) {
      return guardSubjectFrom(await load(), request);
    },
    async admittedSubject(request) {
      return admittedSubjectFrom(await load(), request);
    },
    async ledgerDirectory() {
      return ledgerDirectory((await load()).directory);
    },
  };
}
