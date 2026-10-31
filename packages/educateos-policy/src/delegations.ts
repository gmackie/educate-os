import { z } from "zod";
import {
  Action,
  Classification,
  DelegationId,
  DistrictId,
  EducateOsError,
  PrincipalId,
  ResourceKind,
  Scope,
  scopeContains,
  type AuthorizationRequest,
  type Caller,
  type ResourceRef,
  type SchoolRole,
} from "@educateos/contracts";
import type { PolicyDecider } from "./engine.ts";
import type { SubjectFacts } from "./information.ts";

// Delegation (RFC 0002 §6, SCHO-175): a principal lets one registered client act for them within a
// scope ceiling until it expires. A delegated subject does what both the principal and the ceiling
// allow, judged on every decision against the live roster, so a teacher dropped from a class stops
// their agent there whatever its token says.

/**
 * The client a delegation is for: a client registered with the district's OAuth authorization
 * server, named by that server's issuer and the client ID it assigned. EducateOS treats both as
 * opaque; verifying a client's token is the transport's job.
 */
export const DelegationClient = z.strictObject({
  /** The authorization server's issuer URL. */
  issuer: z.url({ protocol: /^https$/ }).max(2048),
  /** The client ID that server assigned. */
  clientId: z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/, "expected a printable client ID"),
});
/** A delegation's client. */
export type DelegationClient = z.infer<typeof DelegationClient>;

/**
 * The actions a delegation may cover. Approving, deleting, grading, assigning, sharing, exporting,
 * configuring, submitting and publishing are a person's own decisions, never delegated (RFC 0002 §2
 * and §6). `invoke-tool` only opens the tool runner: each record a tool touches is decided again
 * under the same bound.
 */
export const DelegableAction = Action.extract(["read", "list", "create", "update", "review", "invoke-tool"]);
/** A delegable action. */
export type DelegableAction = z.infer<typeof DelegableAction>;

/**
 * The resource kinds a delegation may cover. Never official grades (no grade writes, RFC 0002 §6),
 * personal spaces, guardian relationships, identity links, access grants, delegations themselves,
 * governance settings, budgets or the audit trail.
 */
export const DelegableKind = ResourceKind.exclude([
  "official-grade",
  "personal-workspace",
  "personal-conversation",
  "access-grant",
  "delegation",
  "identity-link",
  "guardian-relationship",
  "capability-config",
  "ai-budget",
  "audit-event",
  "district",
]);
/** A delegable resource kind. */
export type DelegableKind = z.infer<typeof DelegableKind>;

/** The classifications a delegation may cover: never `personal-private` or `restricted` content. */
export const DelegableClassification = Classification.exclude(["personal-private", "restricted"]);
/** A delegable classification. */
export type DelegableClassification = z.infer<typeof DelegableClassification>;

/**
 * The most a delegation lets its client do: requests at its scope or within it, for one of its
 * actions on one of its kinds of resource with one of its classifications.
 */
export const DelegationCeiling = z.strictObject({
  /** The scope requests must fall within, such as one offering. */
  scope: Scope,
  /** The actions covered. */
  actions: z.array(DelegableAction).min(1),
  /** The resource kinds covered. */
  kinds: z.array(DelegableKind).min(1),
  /** The classifications covered. */
  classifications: z.array(DelegableClassification).min(1),
});
/** A delegation ceiling. */
export type DelegationCeiling = z.infer<typeof DelegationCeiling>;

/** The longest a delegation can last: 90 days, after which the grantor issues a new one. */
export const MAX_DELEGATION_HOURS = 90 * 24;

/**
 * The roles a principal may delegate from, held at a scope containing the ceiling's: staff roles,
 * never `student`. The grantor must still hold one at every decision the delegation bounds.
 */
export const DELEGATING_ROLES: readonly SchoolRole[] = ["district-admin", "school-admin", "curriculum-admin", "teacher", "co-teacher"];

/**
 * A principal's grant letting one client act for them within a ceiling until it expires. It is a
 * record the policy engine reads on every request whose subject names it, and every decision it
 * bounds is audited with its ID.
 */
export const Delegation = z.strictObject({
  /** The delegation's ID, which the client's token resolves to. */
  id: DelegationId,
  /** The district. */
  districtId: DistrictId,
  /** The principal the client acts for, who issued it. */
  grantorPrincipalId: PrincipalId,
  /** The client it is for. */
  client: DelegationClient,
  /** The most it allows. */
  ceiling: DelegationCeiling,
  /** When it was issued. */
  issuedAt: z.iso.datetime(),
  /** When it stops allowing anything. */
  expiresAt: z.iso.datetime(),
  /** Set when it was revoked before expiring. */
  revoked: z.strictObject({ by: PrincipalId, at: z.iso.datetime() }).optional(),
});
/** A delegation. */
export type Delegation = z.infer<typeof Delegation>;

/** What issuing a delegation takes. The grantor is the caller, never an input. */
export const NewDelegation = z.strictObject({
  /** The client it is for. */
  client: DelegationClient,
  /** The most it allows. */
  ceiling: DelegationCeiling,
  /** How long it lasts, at most {@link MAX_DELEGATION_HOURS}. */
  durationHours: z.int().min(1).max(MAX_DELEGATION_HOURS),
});
/** A new delegation. */
export type NewDelegation = z.infer<typeof NewDelegation>;

/** Where a district's delegations are kept. Delegations are never deleted: revoking one marks it. */
export interface DelegationStore {
  /** The delegation, or `undefined`. */
  get(id: DelegationId): Promise<Delegation | undefined>;
  /** Every delegation, in issue order. */
  list(): Promise<Delegation[]>;
  /** Adds a delegation, or replaces the one with its ID. */
  put(delegation: Delegation): Promise<void>;
}

/** A {@link DelegationStore} in memory. */
export class InMemoryDelegationStore implements DelegationStore {
  readonly #delegations: Delegation[] = [];

  async get(id: DelegationId): Promise<Delegation | undefined> {
    const found = this.#delegations.find((d) => d.id === id);
    return found === undefined ? undefined : structuredClone(found);
  }

  async list(): Promise<Delegation[]> {
    return structuredClone(this.#delegations);
  }

  async put(delegation: Delegation): Promise<void> {
    const parsed = Delegation.parse(delegation);
    const index = this.#delegations.findIndex((d) => d.id === parsed.id);
    if (index === -1) this.#delegations.push(parsed);
    else this.#delegations[index] = parsed;
  }
}

/** Whether `delegation` is in force at `at`: issued, not yet expired and not revoked. */
export function delegationInForce(delegation: Delegation, at: Date): boolean {
  return delegation.revoked === undefined
    && Date.parse(delegation.issuedAt) <= at.getTime()
    && at.getTime() < Date.parse(delegation.expiresAt);
}

/** The pseudo-rule IDs recorded when a delegation refuses a request before the rule table is read. */
export const DELEGATION_RULE_IDS = {
  /** No such delegation, or it is another principal's or another district's. */
  unknown: "delegation.unknown",
  /** It has expired, been revoked, or is not yet in force. */
  notInForce: "delegation.not-in-force",
  /** Its grantor no longer holds a delegating role over its scope, such as a teacher dropped from the class. */
  grantorStanding: "delegation.grantor-standing",
  /** The request falls outside its ceiling. */
  ceiling: "delegation.ceiling",
} as const;

/**
 * Why `delegation` refuses `request`, as a {@link DELEGATION_RULE_IDS} member, or `undefined` if
 * it lets the rule table decide. `facts` are the subject's, read from the live directory with only
 * roles in force at `at`. An `invoke-tool` request needs only the action in the ceiling: it opens
 * the tool runner on the district, and every record the tool then touches is decided under the
 * same bound.
 */
export function delegationRefusal(
  delegation: Delegation | undefined,
  request: AuthorizationRequest,
  facts: SubjectFacts,
  at: Date,
): string | undefined {
  const { subject, action, resource } = request;
  if (delegation === undefined || delegation.grantorPrincipalId !== subject.principalId || delegation.districtId !== subject.districtId) {
    return DELEGATION_RULE_IDS.unknown;
  }
  if (!delegationInForce(delegation, at)) return DELEGATION_RULE_IDS.notInForce;
  const { ceiling } = delegation;
  const standing = facts.active
    && facts.roles.some((held) => DELEGATING_ROLES.includes(held.role) && scopeContains(held.scope, ceiling.scope));
  if (!standing) return DELEGATION_RULE_IDS.grantorStanding;
  if (!(ceiling.actions as readonly Action[]).includes(action)) return DELEGATION_RULE_IDS.ceiling;
  if (action === "invoke-tool") return undefined;
  if (!withinCeiling(ceiling, resource)) return DELEGATION_RULE_IDS.ceiling;
  return undefined;
}

function withinCeiling(ceiling: DelegationCeiling, resource: ResourceRef): boolean {
  return (ceiling.kinds as readonly ResourceKind[]).includes(resource.kind)
    && (ceiling.classifications as readonly Classification[]).includes(resource.classification)
    && scopeContains(ceiling.scope, resource.scope);
}

/** What a {@link Delegations} service is built from. */
export interface DelegationsOptions {
  /** Where delegations are kept. */
  store: DelegationStore;
  /** Decides and audits issuing, listing and revoking. */
  policy: PolicyDecider;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  return parsed.data;
}

/**
 * Issues, lists and revokes delegations. Each is decided and audited by the policy engine as an
 * action on a `restricted` `delegation` at the ceiling's scope, owned by its grantor: a person over
 * http issues one only within a scope they hold a staff role over, and revokes or reads their own;
 * a district admin reads and revokes any. A delegated subject can do none of this, since no ceiling
 * covers delegations.
 */
export class Delegations {
  readonly #store: DelegationStore;
  readonly #policy: PolicyDecider;
  readonly #now: () => Date;

  constructor(options: DelegationsOptions) {
    this.#store = options.store;
    this.#policy = options.policy;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Issues a delegation from the caller to a client.
   *
   * @throws EducateOsError `validation-failed` for malformed input; `forbidden` unless the caller
   *   may delegate within the ceiling's scope.
   */
  async issue(caller: Caller, rawInput: unknown): Promise<Delegation> {
    const input = parse(NewDelegation, rawInput);
    const id = DelegationId.parse(`dlg_${crypto.randomUUID()}`);
    const resource = this.#resource(input.ceiling.scope, caller.principal.principalId, id);
    if (!(await this.#allows(caller, "create", resource))) {
      throw new EducateOsError("forbidden", "You can only delegate within a class or school you hold a staff role in.");
    }
    const issuedAt = this.#now();
    const delegation = Delegation.parse({
      id,
      districtId: caller.principal.districtId,
      grantorPrincipalId: caller.principal.principalId,
      client: input.client,
      ceiling: input.ceiling,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.durationHours * 3_600_000).toISOString(),
    });
    await this.#store.put(delegation);
    return delegation;
  }

  /** The delegations the caller may read, in force or not: their own, or every one for a district admin. */
  async list(caller: Caller): Promise<Delegation[]> {
    const readable: Delegation[] = [];
    for (const delegation of await this.#store.list()) {
      if (await this.#allows(caller, "read", this.#of(delegation))) readable.push(delegation);
    }
    return readable;
  }

  /**
   * Ends a delegation before it expires. Idempotent.
   *
   * @throws EducateOsError `not-found` for an unknown delegation or one the caller may not read.
   */
  async revoke(caller: Caller, rawId: unknown): Promise<Delegation> {
    const id = parse(DelegationId, rawId);
    const delegation = await this.#store.get(id);
    if (delegation === undefined || !(await this.#allows(caller, "update", this.#of(delegation)))) {
      throw new EducateOsError("not-found", `delegation ${id} was not found.`);
    }
    if (delegation.revoked !== undefined) return delegation;
    const revoked = { ...delegation, revoked: { by: caller.principal.principalId, at: this.#now().toISOString() } };
    await this.#store.put(revoked);
    return revoked;
  }

  #of(delegation: Delegation): ResourceRef {
    return this.#resource(delegation.ceiling.scope, delegation.grantorPrincipalId, delegation.id);
  }

  #resource(scope: Scope, owner: PrincipalId, id: DelegationId): ResourceRef {
    return { kind: "delegation", id, scope, classification: "restricted", ownerPrincipalId: owner };
  }

  async #allows(caller: Caller, action: Action, resource: ResourceRef): Promise<boolean> {
    const request: AuthorizationRequest = { subject: caller.principal, action, resource, context: { channel: caller.channel } };
    const { decision } = await this.#policy.decide(request, caller.correlationId === undefined ? {} : { correlationId: caller.correlationId });
    return decision.effect === "allow";
  }
}
