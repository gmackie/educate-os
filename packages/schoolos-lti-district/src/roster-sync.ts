import { z } from "zod";
import {
  EnrollmentId,
  externalIdentityKey,
  RosterProjection,
  SchoolOsError,
  type AuthorityMap,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type Enrollment,
  type OfferingId,
  type Principal,
  type PrincipalId,
  type SourceLink,
} from "@schoolos/contracts";
import { AcademicSync, assertSyncWritable, type AcademicStore } from "@schoolos/academics";
import { offeringForContext, type PlatformRegistrationStore } from "@schoolos/lti";
import type { RosterSourceStore } from "./stores.ts";
import { tupleKey } from "./table.ts";

/** An enrollment role. */
export type EnrollmentRole = Enrollment["role"];

/**
 * Decides a roster member's enrollment role from the district's own records. A platform's role
 * strings are never an input: the projection carries them only as `untrustedPlatformRoles`, and an
 * LMS calling someone an instructor grants nothing.
 */
export interface RosterRoleSource {
  /** The role `principal` holds in `offeringId`, or `undefined` to hold the member back unenrolled. */
  roleFor(principal: Principal, offeringId: OfferingId, directory: DistrictDirectorySnapshot): EnrollmentRole | undefined;
}

const ENROLLMENT_ROLES: readonly string[] = ["student", "teacher", "co-teacher"];

/**
 * The default {@link RosterRoleSource}: the role the district roster already gives the principal
 * in this offering (an existing enrollment, then a roster role assignment at the offering), and
 * otherwise `student` for a student principal. A staff member the district has not placed in the
 * offering is held back: the platform cannot make anyone a teacher.
 */
export const districtRosterRoles: RosterRoleSource = {
  roleFor(principal, offeringId, directory) {
    const enrolled = directory.enrollments.find((e) => e.offeringId === offeringId && e.principalId === principal.id);
    if (enrolled !== undefined) return enrolled.role;
    const assigned = directory.roleAssignments.find(
      (a) =>
        a.principalId === principal.id &&
        a.source === "roster" &&
        a.scope.level === "offering" &&
        a.scope.offeringId === offeringId &&
        ENROLLMENT_ROLES.includes(a.role),
    );
    if (assigned !== undefined) return assigned.role as EnrollmentRole;
    return principal.kind === "student" ? "student" : undefined;
  },
};

/** What one applied projection changed, and who it left out. Counts only: no identities. */
export const LtiRosterSyncResult = z.strictObject({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deactivated: z.number().int().nonnegative(),
  /** Members with no identity link in the district, skipped. */
  unlinked: z.number().int().nonnegative(),
  /** Linked members the district's records give no role in the offering, held back. */
  unassigned: z.number().int().nonnegative(),
});
/** A roster sync result. */
export type LtiRosterSyncResult = z.infer<typeof LtiRosterSyncResult>;

/** What {@link LtiRosterSync} is built from. */
export interface LtiRosterSyncOptions {
  readonly districtId: DistrictId;
  /** The district directory's store, which `AcademicSync` writes. */
  readonly store: AcademicStore;
  /** The district's source-of-record map. Enrollments must belong to the registration's provider. */
  readonly authority: AuthorityMap;
  readonly registrations: PlatformRegistrationStore;
  readonly sources: RosterSourceStore;
  /** Defaults to {@link districtRosterRoles}. */
  readonly roles?: RosterRoleSource;
}

/** The SchoolOS enrollment ID an LTI roster gives a principal in an offering, the same on every sync. */
async function derivedEnrollmentId(districtId: DistrictId, offeringId: OfferingId, principalId: PrincipalId): Promise<EnrollmentId> {
  const input = new TextEncoder().encode(JSON.stringify(["lti-enrollment", districtId, offeringId, principalId]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return EnrollmentId.parse(`enr_lti-${Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`);
}

/**
 * Applies an NRPS {@link RosterProjection} to the district directory, through `AcademicSync`, the
 * only write path for record types an external system owns. It runs only where the district's
 * authority map names the registration's provider as the source of record for enrollments, and
 * refuses the whole projection otherwise.
 *
 * - A member is found only by the identity link `(district, issuer, sub)`; one with no link is
 *   skipped.
 * - Enrollment roles come from the district's records ({@link RosterRoleSource}), never from the
 *   platform's role strings.
 * - An enrollment is active only while the platform lists the member as active and the principal
 *   itself is `active`; an inactive or graduated principal keeps its records but is not enrolled.
 * - Each enrollment the roster writes gets a `SourceLink`. One the roster later stops listing, or
 *   lists as inactive or deleted, becomes inactive. Nothing is ever deleted, and no principal's own
 *   status is changed: leaving one course says nothing about leaving the district.
 * - A projection no newer than the last one applied for the same context is refused.
 */
export class LtiRosterSync {
  readonly #options: LtiRosterSyncOptions;
  readonly #roles: RosterRoleSource;

  constructor(options: LtiRosterSyncOptions) {
    this.#options = options;
    this.#roles = options.roles ?? districtRosterRoles;
  }

  /** Applies one projection. See the class documentation for every refusal. */
  async apply(input: unknown): Promise<LtiRosterSyncResult> {
    const parsed = RosterProjection.safeParse(input);
    if (!parsed.success) throw new SchoolOsError("validation-failed", "The roster projection is malformed.");
    const projection = parsed.data;
    const { source } = projection;
    if (source.kind !== "lti-nrps") throw new SchoolOsError("validation-failed", "This adapter applies LTI rosters only.");
    if (projection.districtId !== this.#options.districtId) throw new SchoolOsError("forbidden", "The roster belongs to another district.");
    if (projection.members.some((m) => m.identity.districtId !== projection.districtId || m.identity.issuer !== source.issuer)) {
      throw new SchoolOsError("validation-failed", "A roster member's identity is not from the roster's platform.");
    }

    const registration = await this.#options.registrations.get({ issuer: source.issuer, clientId: source.clientId });
    if (registration === undefined) throw new SchoolOsError("not-found", "No such LTI registration.");
    if (offeringForContext(registration, source.contextId) !== projection.offeringId) {
      throw new SchoolOsError("forbidden", "This course is not connected to that offering.");
    }
    const provider = registration.provider;
    assertSyncWritable(this.#options.authority, "enrollment", provider);

    const sourceKey = tupleKey(projection.offeringId, source.issuer, source.clientId, source.contextId);
    const state = await this.#options.sources.load(sourceKey);
    if (state.observedAt !== undefined && Date.parse(projection.observedAt) <= Date.parse(state.observedAt)) {
      throw new SchoolOsError("conflict", "A newer roster for this course has already been applied.");
    }

    const { snapshot } = await this.#options.store.load();
    const byIdentity = new Map<string, Principal>();
    for (const principal of snapshot.principals) {
      for (const identity of principal.externalIdentities) byIdentity.set(externalIdentityKey(identity), principal);
    }

    const result: LtiRosterSyncResult = { added: 0, updated: 0, deactivated: 0, unlinked: 0, unassigned: 0 };
    const changed = new Map<EnrollmentId, Enrollment>();
    const links: Record<EnrollmentId, SourceLink> = { ...state.enrollments };
    const listed = new Set<EnrollmentId>();
    const write = (before: Enrollment | undefined, after: Enrollment): void => {
      if (before?.status === after.status && before.role === after.role) return;
      changed.set(after.id, after);
      if (before === undefined) result.added += 1;
      else if (before.status === "active" && after.status === "inactive") result.deactivated += 1;
      else result.updated += 1;
    };

    // A principal linked under two subjects is one person: listed once, and active if either is.
    const people = new Map<PrincipalId, { principal: Principal; subject: string; listedActive: boolean }>();
    for (const member of projection.members) {
      const principal = byIdentity.get(externalIdentityKey(member.identity));
      if (principal === undefined) {
        result.unlinked += 1;
        continue;
      }
      const seen = people.get(principal.id);
      if (seen === undefined || (!seen.listedActive && member.status === "active")) {
        people.set(principal.id, { principal, subject: member.identity.subject, listedActive: member.status === "active" });
      }
    }

    for (const { principal, subject, listedActive } of people.values()) {
      const role = this.#roles.roleFor(principal, projection.offeringId, snapshot);
      if (role === undefined) {
        result.unassigned += 1;
        continue;
      }
      const existing = snapshot.enrollments.find((e) => e.offeringId === projection.offeringId && e.principalId === principal.id);
      const id = existing?.id ?? (await derivedEnrollmentId(projection.districtId, projection.offeringId, principal.id));
      listed.add(id);
      links[id] = { system: provider, sourcedId: subject, lastSeenAt: projection.observedAt };
      const status = listedActive && principal.status === "active" ? "active" : "inactive";
      if (existing === undefined && status === "inactive") continue;
      write(existing, { id, districtId: projection.districtId, offeringId: projection.offeringId, principalId: principal.id, role, status });
    }

    for (const id of Object.keys(state.enrollments) as EnrollmentId[]) {
      if (listed.has(id)) continue;
      const departed = snapshot.enrollments.find((e) => e.id === id);
      if (departed !== undefined && departed.status === "active") write(departed, { ...departed, status: "inactive" });
    }

    // The links are saved before the directory changes, so an enrollment this sync writes is
    // always one a later sync knows to deactivate, even if this run stops part way.
    await this.#options.sources.save(sourceKey, { ...(state.observedAt === undefined ? {} : { observedAt: state.observedAt }), enrollments: links });
    if (changed.size > 0) {
      await new AcademicSync({ store: this.#options.store, authority: this.#options.authority, provider }).apply({ enrollments: [...changed.values()] });
    }
    await this.#options.sources.save(sourceKey, { observedAt: projection.observedAt, enrollments: links });
    return result;
  }
}
