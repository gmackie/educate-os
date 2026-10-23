import {
  GuardianReadableKind,
  GuardianRelationship,
  guardianRelationshipInForce,
  type DistrictDirectorySnapshot,
  type PrincipalId,
  type ResourceRef,
} from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";
import type { RelationshipFact, RelationshipSource } from "./information.ts";

/**
 * Where a district's guardian relationships are kept (ADR-0012). Relationships are never deleted:
 * revoking or suspending one marks it, so the record every past read was audited under survives.
 * A durable implementation (the district's control Durable Object) implements this same interface.
 */
export interface GuardianRelationshipStore {
  /** Every relationship naming `guardianPrincipalId` as the guardian, in any status. */
  listForGuardian(guardianPrincipalId: PrincipalId): Promise<GuardianRelationship[]>;
  /** Adds a relationship, or replaces the one with its ID. */
  put(relationship: GuardianRelationship): Promise<void>;
}

/** A {@link GuardianRelationshipStore} in memory, for tests and local development. */
export class InMemoryGuardianRelationshipStore implements GuardianRelationshipStore {
  readonly #relationships: GuardianRelationship[] = [];

  async listForGuardian(guardianPrincipalId: PrincipalId): Promise<GuardianRelationship[]> {
    return structuredClone(this.#relationships.filter((r) => r.guardianPrincipalId === guardianPrincipalId));
  }

  async put(relationship: GuardianRelationship): Promise<void> {
    const parsed = GuardianRelationship.parse(relationship);
    const index = this.#relationships.findIndex((r) => r.id === parsed.id);
    if (index === -1) this.#relationships.push(parsed);
    else this.#relationships[index] = parsed;
  }
}

/** The readable kinds that are one student's own records. The others are an offering's, and unowned. */
const STUDENT_OWNED_KINDS: ReadonlySet<GuardianReadableKind> = new Set(["feedback", "official-grade"]);

/**
 * Whether `relationship` covers `resource` for the student it names, in `snapshot`:
 *
 * - The resource is of a kind the relationship opens.
 * - Feedback and an official grade are owned by the student. They stay covered after the student
 *   leaves the offering, as they do for the student.
 * - The offering, its assignments and its announcements are unowned and at an offering the student
 *   is actively enrolled in, as a student.
 * - If the relationship names offerings, the resource is at one of them.
 */
function covers(snapshot: DistrictDirectorySnapshot, relationship: GuardianRelationship, resource: ResourceRef): boolean {
  const kind = GuardianReadableKind.safeParse(resource.kind);
  if (!kind.success || !relationship.readableKinds.includes(kind.data)) return false;
  const { scope } = resource;
  const offeringId = scope.level === "offering" ? scope.offeringId : undefined;
  if (relationship.offeringIds !== undefined && (offeringId === undefined || !relationship.offeringIds.includes(offeringId))) {
    return false;
  }
  if (STUDENT_OWNED_KINDS.has(kind.data)) return resource.ownerPrincipalId === relationship.studentPrincipalId;
  return resource.ownerPrincipalId === undefined
    && offeringId !== undefined && snapshot.enrollments.some((e) =>
    e.principalId === relationship.studentPrincipalId
    && e.offeringId === offeringId
    && e.role === "student"
    && e.status === "active");
}

/**
 * The `guardian-of` relationships a store's records establish, for the policy information point
 * (ADR-0012). A relationship counts only:
 *
 * - for the guardian it names, in its district, while it is in force (`active`, within its dates,
 *   not suspended, consent not withdrawn);
 * - while the guardian is still an active `guardian` principal and the student an active `student`
 *   principal of the directory, read afresh on every decision;
 * - for a resource it covers: one the student owns, or an unowned one at an offering the student is
 *   actively enrolled in, of a kind and in an offering the relationship allows.
 *
 * The fact names the relationship's ID, so the decision's audit entry records which one allowed it.
 */
export function guardianRelationships(
  store: GuardianRelationshipStore,
  directory: AcademicStore,
  now: () => Date = () => new Date(),
): RelationshipSource {
  return {
    async relationships(subject: PrincipalId, resource: ResourceRef): Promise<readonly RelationshipFact[]> {
      if (!GuardianReadableKind.safeParse(resource.kind).success) return [];
      const at = now();
      const candidates = (await store.listForGuardian(subject)).filter((relationship) =>
        relationship.guardianPrincipalId === subject
        && relationship.districtId === resource.scope.districtId
        && guardianRelationshipInForce(relationship, at));
      if (candidates.length === 0) return [];
      const { snapshot } = await directory.load();
      if (snapshot.district.id !== resource.scope.districtId) return [];
      const isActive = (id: PrincipalId, kind: "guardian" | "student") =>
        snapshot.principals.some((p) => p.id === id && p.kind === kind && p.status === "active");
      if (!isActive(subject, "guardian")) return [];
      return candidates
        .filter((relationship) => isActive(relationship.studentPrincipalId, "student") && covers(snapshot, relationship, resource))
        .map((relationship) => ({ relationship: "guardian-of" as const, grantId: relationship.id }));
    },
  };
}
