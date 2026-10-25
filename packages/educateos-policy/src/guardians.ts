import { z } from "zod";
import {
  AuditEventBase,
  GuardianReadableKind,
  GuardianRelationship,
  GuardianRelationshipId,
  guardianRelationshipInForce,
  OfferingId,
  OpaqueCode,
  PrincipalId,
  EducateOsError,
  type Action,
  type AuthorizationRequest,
  type Caller,
  type DistrictDirectorySnapshot,
  type ResourceRef,
} from "@educateos/contracts";
import type { AcademicStore } from "@educateos/academics";
import type { PolicyDecider } from "./engine.ts";
import type { RelationshipFact, RelationshipSource } from "./information.ts";

/**
 * The audit record of one change to a guardian relationship (ADR-0012), kept with the relationship
 * for as long as it is. Like every district audit event it names identifiers only: the reason a
 * relationship was suspended is an opaque code, never free text, so no family detail reaches it.
 *
 * - `recorded`: a district admin recorded it, `pending`.
 * - `guardian-joined`: an invited guardian who already had a guardian principal redeemed the
 *   invitation, so the pending relationship now names them.
 * - `confirmed`: a district admin confirmed it, `active`.
 * - `scope-changed`: a district admin changed the kinds or offerings it opens.
 * - `suspended` and `resumed`: a district admin stopped, then restored, its access.
 * - `revoked`: a district admin ended it.
 */
export const GuardianRelationshipAuditEvent = AuditEventBase.extend({
  action: z.enum([
    "guardian-relationship.recorded",
    "guardian-relationship.guardian-joined",
    "guardian-relationship.confirmed",
    "guardian-relationship.scope-changed",
    "guardian-relationship.suspended",
    "guardian-relationship.resumed",
    "guardian-relationship.revoked",
  ]),
  target: z.strictObject({ relationshipId: GuardianRelationshipId, guardianPrincipalId: PrincipalId, studentPrincipalId: PrincipalId }),
  /** For `suspended`, the opaque reason code. */
  reason: OpaqueCode.optional(),
});
/** A guardian relationship audit event. */
export type GuardianRelationshipAuditEvent = z.infer<typeof GuardianRelationshipAuditEvent>;

/**
 * Where a district's guardian relationships are kept (ADR-0012), with each one's change history.
 * Relationships are never deleted: revoking or suspending one marks it, so the record every past
 * read was audited under survives. `InMemoryGuardianRelationshipStore` is for tests; the district's
 * Durable Object keeps the durable one (`@educateos/district-app/durable-stores`).
 */
export interface GuardianRelationshipStore {
  /** The relationship with this ID, in any status. */
  get(id: GuardianRelationshipId): Promise<GuardianRelationship | undefined>;
  /** Every relationship naming `guardianPrincipalId` as the guardian, in any status. */
  listForGuardian(guardianPrincipalId: PrincipalId): Promise<GuardianRelationship[]>;
  /** Every relationship naming `studentPrincipalId` as the student, in any status. */
  listForStudent(studentPrincipalId: PrincipalId): Promise<GuardianRelationship[]>;
  /**
   * Stores `next` and appends `event` to its history, together, provided the stored relationship
   * is still `expected` (`undefined`: none is stored under its ID). Otherwise it stores nothing and
   * throws `EducateOsError("conflict")`, so of two administrators changing one relationship at once,
   * the second is refused rather than silently overwriting the first.
   */
  commit(next: GuardianRelationship, event: GuardianRelationshipAuditEvent, expected: GuardianRelationship | undefined): Promise<void>;
  /** A relationship's change history, oldest first. */
  history(id: GuardianRelationshipId): Promise<GuardianRelationshipAuditEvent[]>;
}

/** The message a {@link GuardianRelationshipStore} refuses a stale commit with. */
export const GUARDIAN_RELATIONSHIP_CONFLICT = "This guardian relationship changed since you loaded it; review it again.";

/**
 * Parses a commit's relationship and event and checks that the event names that relationship, as
 * every store does before writing. Shared by the stores, so they refuse exactly the same commits.
 */
export function checkGuardianRelationshipCommit(
  next: GuardianRelationship,
  event: GuardianRelationshipAuditEvent,
): { relationship: GuardianRelationship; event: GuardianRelationshipAuditEvent } {
  const relationship = GuardianRelationship.parse(next);
  const parsedEvent = GuardianRelationshipAuditEvent.parse(event);
  if (
    parsedEvent.target.relationshipId !== relationship.id
    || parsedEvent.target.studentPrincipalId !== relationship.studentPrincipalId
    || parsedEvent.target.guardianPrincipalId !== relationship.guardianPrincipalId
    || parsedEvent.districtId !== relationship.districtId
  ) {
    throw new Error("a guardian relationship's audit event must name it");
  }
  return { relationship, event: parsedEvent };
}

/** Whether a stored relationship is the one a commit expects. Both are schema-parsed, so their JSON is canonical. */
export function sameGuardianRelationship(stored: GuardianRelationship | undefined, expected: GuardianRelationship | undefined): boolean {
  return JSON.stringify(stored) === JSON.stringify(expected === undefined ? undefined : GuardianRelationship.parse(expected));
}

/** A {@link GuardianRelationshipStore} in memory, for tests and local development. */
export class InMemoryGuardianRelationshipStore implements GuardianRelationshipStore {
  readonly #relationships = new Map<GuardianRelationshipId, GuardianRelationship>();
  readonly #history: GuardianRelationshipAuditEvent[] = [];

  async get(id: GuardianRelationshipId): Promise<GuardianRelationship | undefined> {
    return structuredClone(this.#relationships.get(id));
  }

  async listForGuardian(guardianPrincipalId: PrincipalId): Promise<GuardianRelationship[]> {
    return structuredClone([...this.#relationships.values()].filter((r) => r.guardianPrincipalId === guardianPrincipalId));
  }

  async listForStudent(studentPrincipalId: PrincipalId): Promise<GuardianRelationship[]> {
    return structuredClone([...this.#relationships.values()].filter((r) => r.studentPrincipalId === studentPrincipalId));
  }

  async commit(next: GuardianRelationship, event: GuardianRelationshipAuditEvent, expected: GuardianRelationship | undefined): Promise<void> {
    const checked = checkGuardianRelationshipCommit(next, event);
    if (!sameGuardianRelationship(this.#relationships.get(checked.relationship.id), expected)) {
      throw new EducateOsError("conflict", GUARDIAN_RELATIONSHIP_CONFLICT);
    }
    this.#relationships.set(checked.relationship.id, checked.relationship);
    this.#history.push(checked.event);
  }

  async history(id: GuardianRelationshipId): Promise<GuardianRelationshipAuditEvent[]> {
    return structuredClone(this.#history.filter((e) => e.target.relationshipId === id));
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

/** What recording a guardian relationship takes. */
export const NewGuardianRelationship = z.strictObject({
  /**
   * The guardian: an active `guardian` principal, or the ID an invitation reserved for one whose
   * first sign-in is still to be approved. Confirming waits until that principal exists.
   */
  guardianPrincipalId: PrincipalId,
  /** The student, an active `student` principal of the district. */
  studentPrincipalId: PrincipalId,
  /** The kinds it opens. Defaults to every readable kind. */
  readableKinds: z.array(GuardianReadableKind).min(1).optional(),
  /** Narrows it to these of the student's offerings. Absent, it covers all of them. */
  offeringIds: z.array(OfferingId).min(1).max(100).optional(),
  /** Whether the student's consent governs it. Defaults to `not-required`, for a minor. */
  consent: z.enum(["not-required", "granted"]).default("not-required"),
  /** When it starts to grant reads. Defaults to now. */
  validFrom: z.iso.datetime().optional(),
  /** When it stops granting reads (exclusive). */
  validUntil: z.iso.datetime().optional(),
});
/** A new guardian relationship. */
export type NewGuardianRelationship = z.input<typeof NewGuardianRelationship>;

/** A change to what a relationship opens. Omitting `offeringIds` widens it to all the student's offerings. */
export const GuardianRelationshipScope = z.strictObject({
  readableKinds: z.array(GuardianReadableKind).min(1),
  offeringIds: z.array(OfferingId).min(1).max(100).optional(),
});
/** A guardian relationship scope. */
export type GuardianRelationshipScope = z.infer<typeof GuardianRelationshipScope>;

/** What a {@link GuardianRelationships} service is built from. */
export interface GuardianRelationshipsOptions {
  /** Where relationships are kept. */
  store: GuardianRelationshipStore;
  /** The district's directory, read to check the guardian and student. Never written. */
  directory: AcademicStore;
  /** Decides and audits every call. */
  policy: PolicyDecider;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** A district admin's call, as the service is given it. */
type AdminCaller = Pick<Caller, "principal" | "channel" | "correlationId">;

function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  return parsed.data;
}

const NOT_ALLOWED = "Only a district administrator can manage guardian relationships.";

/**
 * Records and manages guardian relationships (ADR-0012), modelled on `AppealGrants`. Every call is
 * decided by the policy engine as an action on a `restricted` `guardian-relationship` at district
 * scope, which only a district admin holds (`admin.district.guardian-relationships`): `create` to
 * record, `approve` to confirm, `update` to change, suspend, resume or revoke, `list` and `read` to
 * review. Every change is stored with its audit event, in the same commit, so the history of who
 * confirmed, narrowed, suspended or revoked a relationship is never separate from it.
 *
 * Recording and confirming are separate decisions, as the ADR's onboarding requires: a recorded
 * relationship is `pending` and grants nothing until a district admin confirms it, and confirming
 * waits until the guardian's own sign-in has been approved and their principal exists.
 */
export class GuardianRelationships {
  readonly #store: GuardianRelationshipStore;
  readonly #directory: AcademicStore;
  readonly #policy: PolicyDecider;
  readonly #now: () => Date;

  constructor(options: GuardianRelationshipsOptions) {
    this.#store = options.store;
    this.#directory = options.directory;
    this.#policy = options.policy;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Records a `pending` relationship.
   *
   * @throws EducateOsError `forbidden` unless the caller is a district admin; `validation-failed`
   *   for malformed input, a student who is not an active student of the district, a guardian ID
   *   held by a principal who is not a guardian, or offerings the student was never enrolled in;
   *   `conflict` if the guardian already has an open (pending or active) relationship to the student.
   */
  async record(caller: AdminCaller, rawInput: unknown): Promise<GuardianRelationship> {
    const id = GuardianRelationshipId.parse(`grl_${crypto.randomUUID()}`);
    await this.#require(caller, "create", id);
    const input = parseInput(NewGuardianRelationship, rawInput);
    const { snapshot } = await this.#directory.load();
    const student = snapshot.principals.find((p) => p.id === input.studentPrincipalId);
    if (student === undefined || student.kind !== "student" || student.status !== "active") {
      throw new EducateOsError("validation-failed", "A guardian relationship must name an active student of this district.");
    }
    const guardian = snapshot.principals.find((p) => p.id === input.guardianPrincipalId);
    if (guardian !== undefined && guardian.kind !== "guardian") {
      throw new EducateOsError("validation-failed", "Only a guardian principal can hold a guardian relationship.");
    }
    if (input.offeringIds !== undefined) this.#checkOfferings(snapshot, input.studentPrincipalId, input.offeringIds);
    const open = (await this.#store.listForStudent(input.studentPrincipalId))
      .some((r) => r.guardianPrincipalId === input.guardianPrincipalId && r.status !== "revoked");
    if (open) throw new EducateOsError("conflict", "This guardian already has a relationship to this student.");

    const at = this.#now().toISOString();
    const relationship = parseInput(GuardianRelationship, {
      id,
      districtId: snapshot.district.id,
      guardianPrincipalId: input.guardianPrincipalId,
      studentPrincipalId: input.studentPrincipalId,
      status: "pending",
      readableKinds: input.readableKinds ?? [...GuardianReadableKind.options],
      ...(input.offeringIds === undefined ? {} : { offeringIds: input.offeringIds }),
      consent: input.consent,
      validFrom: input.validFrom ?? at,
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      created: { by: caller.principal.principalId, at },
    });
    await this.#store.commit(relationship, this.#event(caller, relationship, "guardian-relationship.recorded", at), undefined);
    return relationship;
  }

  /**
   * Confirms a pending relationship, which makes it `active`. Idempotent for one already active.
   *
   * @throws EducateOsError `forbidden` unless the caller is a district admin; `not-found` for an
   *   unknown relationship; `conflict` for a revoked one, or while the guardian's sign-in has not
   *   been approved, or if the guardian or student is no longer active.
   */
  async confirm(caller: AdminCaller, rawId: unknown): Promise<GuardianRelationship> {
    const id = parseInput(GuardianRelationshipId, rawId);
    await this.#require(caller, "approve", id);
    const current = await this.#get(id);
    if (current.status === "active") return current;
    if (current.status === "revoked") throw new EducateOsError("conflict", "A revoked guardian relationship cannot be confirmed.");
    const { snapshot } = await this.#directory.load();
    const isActive = (principalId: PrincipalId, kind: "guardian" | "student") =>
      snapshot.principals.some((p) => p.id === principalId && p.kind === kind && p.status === "active");
    if (!isActive(current.guardianPrincipalId, "guardian")) {
      throw new EducateOsError("conflict", "The guardian's sign-in has not been approved yet, so there is no guardian to confirm.");
    }
    if (!isActive(current.studentPrincipalId, "student")) throw new EducateOsError("conflict", "The student is no longer active.");
    const at = this.#now().toISOString();
    const next = { ...current, status: "active" as const, confirmed: { by: caller.principal.principalId, at } };
    await this.#store.commit(next, this.#event(caller, next, "guardian-relationship.confirmed", at), current);
    return next;
  }

  /**
   * Changes the kinds and offerings a relationship opens, such as withholding grades from one
   * guardian. Not for a revoked relationship.
   */
  async updateScope(caller: AdminCaller, rawId: unknown, rawScope: unknown): Promise<GuardianRelationship> {
    const id = parseInput(GuardianRelationshipId, rawId);
    await this.#require(caller, "update", id);
    const scope = parseInput(GuardianRelationshipScope, rawScope);
    const current = await this.#open(id);
    if (scope.offeringIds !== undefined) this.#checkOfferings((await this.#directory.load()).snapshot, current.studentPrincipalId, scope.offeringIds);
    const { offeringIds: _, ...rest } = current;
    const next = parseInput(GuardianRelationship, {
      ...rest,
      readableKinds: scope.readableKinds,
      ...(scope.offeringIds === undefined ? {} : { offeringIds: scope.offeringIds }),
    });
    await this.#store.commit(next, this.#event(caller, next, "guardian-relationship.scope-changed", this.#now().toISOString()), current);
    return next;
  }

  /** Suspends a relationship's access without ending it, for an opaque reason code. Idempotent. */
  async suspend(caller: AdminCaller, rawId: unknown, rawReason: unknown): Promise<GuardianRelationship> {
    const id = parseInput(GuardianRelationshipId, rawId);
    await this.#require(caller, "update", id);
    const reason = parseInput(OpaqueCode, rawReason);
    const current = await this.#open(id);
    if (current.suspended !== undefined) return current;
    const at = this.#now().toISOString();
    const next = { ...current, suspended: { by: caller.principal.principalId, at, reason } };
    await this.#store.commit(next, { ...this.#event(caller, next, "guardian-relationship.suspended", at), reason }, current);
    return next;
  }

  /** Lifts a suspension. Idempotent. */
  async resume(caller: AdminCaller, rawId: unknown): Promise<GuardianRelationship> {
    const id = parseInput(GuardianRelationshipId, rawId);
    await this.#require(caller, "update", id);
    const current = await this.#open(id);
    if (current.suspended === undefined) return current;
    const { suspended: _, ...next } = current;
    await this.#store.commit(next, this.#event(caller, next, "guardian-relationship.resumed", this.#now().toISOString()), current);
    return next;
  }

  /** Ends a relationship. It is kept, revoked, and never reactivated. Idempotent. */
  async revoke(caller: AdminCaller, rawId: unknown): Promise<GuardianRelationship> {
    const id = parseInput(GuardianRelationshipId, rawId);
    await this.#require(caller, "update", id);
    const current = await this.#get(id);
    if (current.status === "revoked") return current;
    const at = this.#now().toISOString();
    const next = { ...current, status: "revoked" as const, revoked: { by: caller.principal.principalId, at } };
    await this.#store.commit(next, this.#event(caller, next, "guardian-relationship.revoked", at), current);
    return next;
  }

  /** Every relationship of a student, in any status, for review. */
  async listForStudent(caller: AdminCaller, rawStudentId: unknown): Promise<GuardianRelationship[]> {
    const studentId = parseInput(PrincipalId, rawStudentId);
    await this.#require(caller, "list");
    return this.#store.listForStudent(studentId);
  }

  /** A relationship's change history, oldest first. */
  async history(caller: AdminCaller, rawId: unknown): Promise<GuardianRelationshipAuditEvent[]> {
    const id = parseInput(GuardianRelationshipId, rawId);
    await this.#require(caller, "read", id);
    await this.#get(id);
    return this.#store.history(id);
  }

  async #get(id: GuardianRelationshipId): Promise<GuardianRelationship> {
    const relationship = await this.#store.get(id);
    if (relationship === undefined || relationship.districtId !== (await this.#directory.load()).snapshot.district.id) {
      throw new EducateOsError("not-found", "No such guardian relationship in this district.");
    }
    return relationship;
  }

  async #open(id: GuardianRelationshipId): Promise<GuardianRelationship> {
    const relationship = await this.#get(id);
    if (relationship.status === "revoked") throw new EducateOsError("conflict", "This guardian relationship has been revoked.");
    return relationship;
  }

  /** Refuses offerings the student has never been enrolled in as a student. */
  #checkOfferings(snapshot: DistrictDirectorySnapshot, studentId: PrincipalId, offeringIds: readonly string[]): void {
    const enrolled = new Set(snapshot.enrollments.filter((e) => e.principalId === studentId && e.role === "student").map((e) => e.offeringId as string));
    if (!offeringIds.every((id) => enrolled.has(id))) {
      throw new EducateOsError("validation-failed", "A guardian relationship can only name offerings the student is enrolled in.");
    }
  }

  #event(
    caller: AdminCaller,
    relationship: GuardianRelationship,
    action: GuardianRelationshipAuditEvent["action"],
    at: string,
  ): GuardianRelationshipAuditEvent {
    return {
      districtId: relationship.districtId,
      actor: { principalId: caller.principal.principalId },
      action,
      target: { relationshipId: relationship.id, guardianPrincipalId: relationship.guardianPrincipalId, studentPrincipalId: relationship.studentPrincipalId },
      at,
    };
  }

  async #require(caller: AdminCaller, action: Action, id?: GuardianRelationshipId): Promise<void> {
    const request: AuthorizationRequest = {
      subject: caller.principal,
      action,
      resource: {
        kind: "guardian-relationship",
        ...(id === undefined ? {} : { id }),
        scope: { level: "district", districtId: caller.principal.districtId },
        classification: "restricted",
      },
      context: { channel: caller.channel },
    };
    const { decision } = await this.#policy.decide(request, caller.correlationId === undefined ? {} : { correlationId: caller.correlationId });
    if (decision.effect !== "allow") throw new EducateOsError("forbidden", NOT_ALLOWED);
  }
}
