// Guardian learning guidance (Guidance and Evidence). ADR-0012 keeps a guardian relationship
// read-only and limited to `GUARDIAN_READABLE_KINDS`; this module does NOT widen either. It adds a
// second, separate record: a `GuardianGuidanceGrant` that a district administrator turns on for one
// relationship, and a relationship source that answers only for the `learning-guidance` kind. Nothing
// here is granted by default: a new relationship has no grant, so a guardian can neither suggest a
// topic nor read a progress summary until an administrator opts that one relationship in.
import { z } from "zod";
import {
  DistrictId,
  EducateOsError,
  GuardianRelationshipId,
  guardianRelationshipInForce,
  PrincipalId,
  UtcTimestamp,
  type Action,
  type DistrictDirectorySnapshot,
  type GuardianRelationship,
  type ResourceRef,
} from "@educateos/contracts";
import type { AcademicStore } from "@educateos/academics";
import type { GuardianRelationshipStore } from "./guardians.ts";
import type { RelationshipFact, RelationshipSource } from "./information.ts";

/**
 * What an administrator may switch on for one guardian relationship.
 *
 * - `suggest`: the guardian may send low-stakes curiosity or hobby suggestions for the child. A
 *   suggestion is never an assignment and reaches the child only after a teacher shares it.
 * - `progress`: the guardian may read the permitted progress summary: per standard a teacher
 *   prioritised, only a coarse state for their own child. Never work, responses or conversations.
 */
export const GUARDIAN_GUIDANCE_CAPABILITIES = ["suggest", "progress"] as const;
/** One guardian guidance capability. */
export const GuardianGuidanceCapability = z.enum(GUARDIAN_GUIDANCE_CAPABILITIES);
/** A guardian guidance capability. */
export type GuardianGuidanceCapability = z.infer<typeof GuardianGuidanceCapability>;

/** One change to a grant, kept with it, so the opt-in's whole history survives revocation. */
export const GuardianGuidanceEvent = z.strictObject({
  action: z.enum(["enabled", "changed", "revoked"]),
  by: PrincipalId,
  at: UtcTimestamp,
  capabilities: z.array(GuardianGuidanceCapability),
});
/** A grant change. */
export type GuardianGuidanceEvent = z.infer<typeof GuardianGuidanceEvent>;

/**
 * The explicit opt-in that lets one guardian relationship reach learning guidance. It never changes
 * the relationship: that record stays read-only and keeps its own `readableKinds`. The grant is
 * honoured only while that relationship is in force, so suspending or revoking the relationship ends it too.
 */
export const GuardianGuidanceGrant = z.strictObject({
  relationshipId: GuardianRelationshipId,
  districtId: DistrictId,
  guardianPrincipalId: PrincipalId,
  studentPrincipalId: PrincipalId,
  /** Empty once revoked; never empty while enabled. */
  capabilities: z.array(GuardianGuidanceCapability).max(GUARDIAN_GUIDANCE_CAPABILITIES.length),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  history: z.array(GuardianGuidanceEvent).min(1),
}).superRefine((grant, ctx) => {
  if (grant.enabled !== (grant.capabilities.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["capabilities"], message: "a grant is enabled exactly when it names a capability" });
  }
  if (new Set(grant.capabilities).size !== grant.capabilities.length) {
    ctx.addIssue({ code: "custom", path: ["capabilities"], message: "a capability is listed twice" });
  }
});
/** A guardian guidance grant. */
export type GuardianGuidanceGrant = z.infer<typeof GuardianGuidanceGrant>;

/** Where grants are kept, with revision checks so two administrators cannot overwrite each other. */
export interface GuardianGuidanceGrantStore {
  /** The grant for a relationship, if one was ever recorded. */
  get(relationshipId: GuardianRelationshipId): Promise<GuardianGuidanceGrant | undefined>;
  /** Every grant for a student's relationships. */
  listForStudent(studentPrincipalId: PrincipalId): Promise<GuardianGuidanceGrant[]>;
  /** Revokes active guidance grants only; preserves the guardian identity relationship and grant history. Trusted lifecycle use. */
  revokeForStudent(studentId: PrincipalId, by: PrincipalId, at: string): void;
  /** Stores `next` if the stored revision is `expectedRevision` (0: none), else `conflict`. */
  save(next: GuardianGuidanceGrant, expectedRevision: number): Promise<void>;
}

/** The message a stale grant change is refused with. */
export const GUARDIAN_GUIDANCE_CONFLICT = "This guardian's learning-guidance access changed. Reload it before trying again.";

/** A {@link GuardianGuidanceGrantStore} in memory, for tests and local development. */
export class InMemoryGuardianGuidanceGrantStore implements GuardianGuidanceGrantStore {
  readonly #grants = new Map<GuardianRelationshipId, GuardianGuidanceGrant>();
  readonly assertWritable: ((studentId: PrincipalId) => void) | undefined;
  constructor(assertWritable?: (studentId: PrincipalId) => void) { this.assertWritable = assertWritable; }
  revokeForStudent(studentId: PrincipalId, by: PrincipalId, at: string): void {
    for (const grant of this.#grants.values()) {
      if (grant.studentPrincipalId === studentId && grant.enabled) this.#grants.set(grant.relationshipId, revokedGuardianGuidanceGrant(grant, by, at));
    }
  }
  /** Internal synchronous inventory for atomic in-memory subject erasure. */
  activeForStudent(studentId: string): GuardianGuidanceGrant[] { return [...this.#grants.values()].filter((g) => g.studentPrincipalId === studentId && g.enabled); }
  async get(relationshipId: GuardianRelationshipId): Promise<GuardianGuidanceGrant | undefined> {
    return structuredClone(this.#grants.get(relationshipId));
  }
  async listForStudent(studentPrincipalId: PrincipalId): Promise<GuardianGuidanceGrant[]> {
    return structuredClone([...this.#grants.values()].filter((g) => g.studentPrincipalId === studentPrincipalId));
  }
  async save(raw: GuardianGuidanceGrant, expectedRevision: number): Promise<void> {
    const next = GuardianGuidanceGrant.parse(raw);
    if (next.enabled) this.assertWritable?.(next.studentPrincipalId);
    if ((this.#grants.get(next.relationshipId)?.revision ?? 0) !== expectedRevision || next.revision !== expectedRevision + 1) {
      throw new EducateOsError("conflict", GUARDIAN_GUIDANCE_CONFLICT);
    }
    this.#grants.set(next.relationshipId, structuredClone(next));
  }
}

/**
 * The next grant for `relationship` once an administrator sets its capabilities (empty revokes).
 * Pure, so the stores and the route share one definition of what a grant change records.
 */
export function nextGuardianGuidanceGrant(
  current: GuardianGuidanceGrant | undefined,
  relationship: GuardianRelationship,
  capabilities: readonly GuardianGuidanceCapability[],
  by: PrincipalId,
  at: Date,
): GuardianGuidanceGrant {
  const unique = [...new Set(capabilities)];
  const action = unique.length === 0 ? "revoked" : current?.enabled === true ? "changed" : "enabled";
  return GuardianGuidanceGrant.parse({
    relationshipId: relationship.id,
    districtId: relationship.districtId,
    guardianPrincipalId: relationship.guardianPrincipalId,
    studentPrincipalId: relationship.studentPrincipalId,
    capabilities: unique,
    enabled: unique.length > 0,
    revision: (current?.revision ?? 0) + 1,
    history: [...current?.history ?? [], { action, by, at: at.toISOString(), capabilities: unique }],
  });
}

/** The capability an action on `learning-guidance` needs: sending is `suggest`, reading is `progress`. */
function capabilityFor(action: Action | undefined): GuardianGuidanceCapability | undefined {
  if (action === "create") return "suggest";
  if (action === "read" || action === "list") return "progress";
  return undefined;
}

/**
 * Whether `relationship` may reach `resource`: the resource is the student's own guidance in an
 * offering they are actively enrolled in, and, if the relationship names offerings, one of them.
 * The relationship must also still let the guardian see the offering at all (`offering` among its
 * `readableKinds`), so a district that withheld a class from a guardian withholds its guidance too.
 */
function covers(snapshot: DistrictDirectorySnapshot, relationship: GuardianRelationship, resource: ResourceRef): boolean {
  if (resource.ownerPrincipalId !== relationship.studentPrincipalId) return false;
  if (!relationship.readableKinds.includes("offering")) return false;
  if (resource.scope.level !== "offering") return false;
  const { offeringId } = resource.scope;
  if (relationship.offeringIds !== undefined && !relationship.offeringIds.includes(offeringId)) return false;
  return snapshot.enrollments.some((e) =>
    e.principalId === relationship.studentPrincipalId && e.offeringId === offeringId && e.role === "student" && e.status === "active");
}

/**
 * The `guardian-of` facts for `learning-guidance`, and for that kind only. A fact exists only while
 * all of these hold, each read afresh on every decision: the relationship is in force
 * (confirmed, within its dates, not suspended, consent not withdrawn); the guardian and student are
 * active principals of the district; an administrator's grant on exactly that relationship names the
 * capability this action needs; and the resource is the child's own guidance in a class they attend.
 * Every other kind answers nothing, so this source can never widen what ADR-0012 lets a guardian read.
 */
export function guardianGuidanceRelationships(
  grants: GuardianGuidanceGrantStore,
  relationships: GuardianRelationshipStore,
  directory: AcademicStore,
  now: () => Date = () => new Date(),
): RelationshipSource {
  return {
    async relationships(subject, resource, action): Promise<readonly RelationshipFact[]> {
      if (resource.kind !== "learning-guidance") return [];
      const needed = capabilityFor(action);
      if (needed === undefined) return [];
      const at = now();
      const candidates = (await relationships.listForGuardian(subject)).filter((r) =>
        r.guardianPrincipalId === subject && r.districtId === resource.scope.districtId && guardianRelationshipInForce(r, at));
      if (candidates.length === 0) return [];
      const { snapshot } = await directory.load();
      if (snapshot.district.id !== resource.scope.districtId) return [];
      const isActive = (id: PrincipalId, kind: "guardian" | "student") =>
        snapshot.principals.some((p) => p.id === id && p.kind === kind && p.status === "active");
      if (!isActive(subject, "guardian")) return [];
      const facts: RelationshipFact[] = [];
      for (const relationship of candidates) {
        if (!isActive(relationship.studentPrincipalId, "student") || !covers(snapshot, relationship, resource)) continue;
        const grant = await grants.get(relationship.id);
        if (grant?.enabled !== true || !grant.capabilities.includes(needed)
          || grant.guardianPrincipalId !== subject || grant.studentPrincipalId !== relationship.studentPrincipalId) continue;
        facts.push({ relationship: "guardian-of", grantId: relationship.id });
      }
      return facts;
    },
  };
}

/** Content-free revocation that preserves the existing access history. */
export function revokedGuardianGuidanceGrant(grant: GuardianGuidanceGrant, by: PrincipalId, at: string): GuardianGuidanceGrant {
  return GuardianGuidanceGrant.parse({ ...grant, revision: grant.revision + 1, enabled: false, capabilities: [], history: [...grant.history, { action: "revoked", by, at, capabilities: [] }] });
}
