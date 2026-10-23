import { z } from "zod";
import {
  DistrictId,
  PrincipalId,
  SchoolOsError,
  type Action,
  type AuthorizationRequest,
  type Caller,
  type ResourceRef,
} from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";
import type { PolicyDecider } from "./engine.ts";
import { subjectFactsFrom, type RelationshipSource } from "./information.ts";
import { APPEAL_RESOURCE_KINDS } from "./rules.ts";

/** Why an appeal grant exists. A grant names exactly one purpose, recorded with every use. */
export const AppealPurpose = z.enum(["grade-appeal", "academic-integrity-appeal"]);
/** An appeal purpose. */
export type AppealPurpose = z.infer<typeof AppealPurpose>;

/** The longest an appeal grant can last: two weeks, after which a new one, with a new reason, is needed. */
export const MAX_APPEAL_GRANT_HOURS = 14 * 24;

/** The one resource an appeal grant opens: a student's submission, artifact or feedback, by ID. */
export const AppealTarget = z.strictObject({
  /** The resource kind. */
  kind: z.enum(APPEAL_RESOURCE_KINDS),
  /** The resource's own ID. */
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
});
/** An appeal target. */
export type AppealTarget = z.infer<typeof AppealTarget>;

/** An appeal grant's ID. */
export const AppealGrantId = z.string().regex(/^agr_[0-9a-f-]{36}$/);
/** An appeal grant ID. */
export type AppealGrantId = z.infer<typeof AppealGrantId>;

/**
 * A purpose-bound, time-limited grant letting one administrator read one piece of one student's
 * course work, such as for a grade appeal (SCHO-56). It is a record the policy engine reads
 * through {@link appealGrantRelationships}; the `appeal.reviewer.read` rule is what allows the
 * read, so the administrator must also still hold an admin role over the work, the work must be
 * `course` (never `personal-private`), and every read is audited with the grant's ID.
 */
export const AppealAccessGrant = z.strictObject({
  /** The grant's ID, recorded in the audit entry of every read it allows. */
  id: AppealGrantId,
  /** The district. */
  districtId: DistrictId,
  /** Why access is needed. */
  purpose: AppealPurpose,
  /** The administrator who may read. */
  granteePrincipalId: PrincipalId,
  /** The student whose work it is. The target must be owned by them. */
  studentPrincipalId: PrincipalId,
  /** The one resource the grant opens. */
  target: AppealTarget,
  /** The issuer's reason, kept with the grant and never copied into the content-free audit trail. */
  reason: z.string().trim().min(10).max(1000),
  /** The district admin who issued it. */
  issuedBy: PrincipalId,
  /** When it was issued. */
  issuedAt: z.iso.datetime(),
  /** When it stops allowing reads. */
  expiresAt: z.iso.datetime(),
  /** Set when it was revoked before expiring. */
  revoked: z.strictObject({ by: PrincipalId, at: z.iso.datetime() }).optional(),
});
/** An appeal access grant. */
export type AppealAccessGrant = z.infer<typeof AppealAccessGrant>;

/** What issuing an appeal grant takes. */
export const NewAppealGrant = z.strictObject({
  /** Why access is needed. */
  purpose: AppealPurpose,
  /** The administrator who may read. */
  granteePrincipalId: PrincipalId,
  /** The student whose work it is. */
  studentPrincipalId: PrincipalId,
  /** The one resource it opens. */
  target: AppealTarget,
  /** Why, in words an auditor can check, at least ten characters. */
  reason: z.string().trim().min(10).max(1000),
  /** How long it lasts, at most {@link MAX_APPEAL_GRANT_HOURS}. */
  durationHours: z.int().min(1).max(MAX_APPEAL_GRANT_HOURS),
});
/** A new appeal grant. */
export type NewAppealGrant = z.infer<typeof NewAppealGrant>;

/** Where a district's appeal grants are kept. Grants are never deleted: revoking one marks it. */
export interface AppealGrantStore {
  /** Every grant, in issue order. */
  list(): Promise<AppealAccessGrant[]>;
  /** Adds a grant, or replaces the one with its ID. */
  put(grant: AppealAccessGrant): Promise<void>;
}

/** An {@link AppealGrantStore} in memory. */
export class InMemoryAppealGrantStore implements AppealGrantStore {
  readonly #grants: AppealAccessGrant[] = [];

  async list(): Promise<AppealAccessGrant[]> {
    return structuredClone(this.#grants);
  }

  async put(grant: AppealAccessGrant): Promise<void> {
    const parsed = AppealAccessGrant.parse(grant);
    const index = this.#grants.findIndex((g) => g.id === parsed.id);
    if (index === -1) this.#grants.push(parsed);
    else this.#grants[index] = parsed;
  }
}

/** Whether `grant` allows a read at `at`: issued, not yet expired and not revoked. */
export function appealGrantInForce(grant: AppealAccessGrant, at: Date): boolean {
  return grant.revoked === undefined && Date.parse(grant.issuedAt) <= at.getTime() && at.getTime() < Date.parse(grant.expiresAt);
}

/**
 * The `appeal-reviewer` relationships a store's grants establish, for the policy information
 * point. A grant counts only for its grantee, for the exact resource it names (kind and ID), when
 * that resource is owned by the student it names, in its district, while it is in force.
 */
export function appealGrantRelationships(store: AppealGrantStore, now: () => Date = () => new Date()): RelationshipSource {
  return {
    async relationships(subject: PrincipalId, resource: ResourceRef) {
      if (resource.id === undefined || resource.ownerPrincipalId === undefined) return [];
      const at = now();
      return (await store.list())
        .filter((grant) =>
          grant.granteePrincipalId === subject
          && grant.districtId === resource.scope.districtId
          && grant.target.kind === resource.kind
          && grant.target.id === resource.id
          && grant.studentPrincipalId === resource.ownerPrincipalId
          && appealGrantInForce(grant, at))
        .map((grant) => ({ relationship: "appeal-reviewer" as const, grantId: grant.id }));
    },
  };
}

/** What an {@link AppealGrants} service is built from. */
export interface AppealGrantsOptions {
  /** Where grants are kept. */
  store: AppealGrantStore;
  /** The district's directory, read to check the grantee and student. Never written. */
  directory: AcademicStore;
  /** Decides and audits issuing, listing and revoking. */
  policy: PolicyDecider;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SchoolOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  return parsed.data;
}

/**
 * Issues and revokes appeal grants (SCHO-56). Only a district admin may, each action is decided
 * and audited by the policy engine as an action on a `restricted` `access-grant`, and a grant
 * always names a purpose, one administrator, one student, one resource, a reason and an expiry of
 * at most two weeks. A district admin may name themselves: the grant, its reason and every read it
 * allows stay in the record either way.
 */
export class AppealGrants {
  readonly #store: AppealGrantStore;
  readonly #directory: AcademicStore;
  readonly #policy: PolicyDecider;
  readonly #now: () => Date;

  constructor(options: AppealGrantsOptions) {
    this.#store = options.store;
    this.#directory = options.directory;
    this.#policy = options.policy;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Issues a grant.
   *
   * @throws SchoolOsError `forbidden` unless the caller is a district admin; `validation-failed`
   *   for malformed input, a grantee who holds no administrator role, or a student who is not one.
   */
  async issue(caller: Caller, rawInput: unknown): Promise<AppealAccessGrant> {
    const id: AppealGrantId = `agr_${crypto.randomUUID()}`;
    await this.#require(caller, "create", id);
    const input = parse(NewAppealGrant, rawInput);
    const { snapshot } = await this.#directory.load();
    const grantee = subjectFactsFrom(snapshot, input.granteePrincipalId, this.#now());
    if (grantee === undefined || !grantee.roles.some((r) => r.role === "district-admin" || r.role === "school-admin")) {
      throw new SchoolOsError("validation-failed", "An appeal grant can only name an administrator of this district.");
    }
    const student = snapshot.principals.find((p) => p.id === input.studentPrincipalId);
    if (student === undefined || student.kind !== "student") {
      throw new SchoolOsError("validation-failed", "An appeal grant must name a student of this district.");
    }
    const issuedAt = this.#now();
    const grant = AppealAccessGrant.parse({
      id,
      districtId: snapshot.district.id,
      purpose: input.purpose,
      granteePrincipalId: input.granteePrincipalId,
      studentPrincipalId: input.studentPrincipalId,
      target: input.target,
      reason: input.reason,
      issuedBy: caller.principal.principalId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.durationHours * 3_600_000).toISOString(),
    });
    await this.#store.put(grant);
    return grant;
  }

  /** Every grant in the district, in force or not, for review. */
  async list(caller: Caller): Promise<AppealAccessGrant[]> {
    await this.#require(caller, "list");
    return this.#store.list();
  }

  /**
   * Ends a grant before it expires. Idempotent.
   *
   * @throws SchoolOsError `forbidden` unless the caller is a district admin, `not-found` for an
   *   unknown grant.
   */
  async revoke(caller: Caller, rawGrantId: unknown): Promise<AppealAccessGrant> {
    const grantId = parse(AppealGrantId, rawGrantId);
    await this.#require(caller, "update", grantId);
    const grant = (await this.#store.list()).find((g) => g.id === grantId);
    if (grant === undefined) throw new SchoolOsError("not-found", `appeal grant ${grantId} was not found.`);
    if (grant.revoked !== undefined) return grant;
    const revoked = { ...grant, revoked: { by: caller.principal.principalId, at: this.#now().toISOString() } };
    await this.#store.put(revoked);
    return revoked;
  }

  async #require(caller: Caller, action: Action, id?: string): Promise<void> {
    const districtId = caller.principal.districtId;
    const request: AuthorizationRequest = {
      subject: caller.principal,
      action,
      resource: { kind: "access-grant", ...(id === undefined ? {} : { id }), scope: { level: "district", districtId }, classification: "restricted" },
      context: { channel: caller.channel },
    };
    const { decision } = await this.#policy.decide(request, caller.correlationId === undefined ? {} : { correlationId: caller.correlationId });
    if (decision.effect !== "allow") throw new SchoolOsError("forbidden", "Only a district administrator can manage appeal grants.");
  }
}
