import type { z } from "zod";
import {
  Action,
  DistrictId,
  precheckAuthorization,
  PrincipalId,
  RequestChannel,
  ResourceKind,
  roleAssignmentInForce,
  scopeContains,
  type AuthorizationRequest,
  type AuthorizeOptions,
  type Authorizer,
  type Decision,
  type PolicySettings,
} from "@educateos/contracts";
import { PolicyAuditEvent, type PolicyAuditSink } from "./audit.ts";
import type { PolicyInformationPoint, RelationshipFact, SubjectFacts } from "./information.ts";
import { DEFAULT_DENY_RULE_ID, DEFAULT_POLICY_RULES, PolicyRuleTable, type Ownership, type PolicyRule, type RuleCondition } from "./rules.ts";

/** A decision with the rule that made it and the correlation ID it was audited under. */
export interface PolicyDecision {
  /** The decision. */
  decision: Decision;
  /** The rule that decided, as recorded in the audit event. */
  ruleId: string;
  /** The audit event's correlation ID. */
  correlationId: string;
  /** The record whose relationship the deciding rule relied on, such as an appeal grant. */
  grantId?: string;
}

/** Decides requests and reports which rule decided. {@link PolicyEngine} is the implementation. */
export interface PolicyDecider {
  /**
   * Decides one unvalidated request and audits the decision. Pass `correlationId` to group the
   * decisions one invocation makes; otherwise a new one is generated.
   */
  decide(request: unknown, options?: { correlationId?: string }): Promise<PolicyDecision>;
}

/** What a {@link PolicyEngine} is built from. */
export interface PolicyEngineOptions {
  /** Where subject facts and the policy floor come from. */
  information: PolicyInformationPoint;
  /** Where every decision is recorded. */
  audit: PolicyAuditSink;
  /** The ordered rule table. Defaults to {@link DEFAULT_POLICY_RULES}. */
  rules?: readonly PolicyRule[];
  /** The clock dated role assignments are judged by at each decision. Defaults to the system clock. */
  now?: () => Date;
}

/** The rule IDs recorded for decisions made before the rule table is consulted. */
export const PSEUDO_RULE_IDS = {
  invalidRequest: "precheck.invalid-request",
  crossDistrict: "precheck.cross-district",
  unknownSubject: "subject.unknown",
  unknownScope: "scope.unknown",
  noMatch: DEFAULT_DENY_RULE_ID,
} as const;

/**
 * The EducateOS ABAC engine (roadmap A02). It runs `precheckAuthorization`, looks the subject up
 * through the policy information point, refuses a scope naming a school or offering the directory
 * does not have, and then walks the rule table in order: the first rule whose condition matches
 * decides. A request no rule matches is denied with `no-matching-grant`. Every decision, including
 * prechecks, is written to the audit sink with the deciding rule's ID and, when that rule relied on
 * a relationship, the ID of the record that established it.
 *
 * A dated role assignment counts only while it is in force when the decision is made, whatever
 * the information point returned, so an expired assignment grants nothing even through a cached or
 * hand-built set of facts (ADR-0012).
 */
export class PolicyEngine implements Authorizer, PolicyDecider {
  readonly #information: PolicyInformationPoint;
  readonly #audit: PolicyAuditSink;
  readonly #rules: readonly PolicyRule[];
  readonly #now: () => Date;

  constructor(options: PolicyEngineOptions) {
    this.#information = options.information;
    this.#audit = options.audit;
    this.#rules = options.rules === undefined ? DEFAULT_POLICY_RULES : PolicyRuleTable.parse(options.rules);
    this.#now = options.now ?? (() => new Date());
  }

  async authorize(request: unknown, options: AuthorizeOptions = {}): Promise<Decision> {
    return (await this.decide(request, options)).decision;
  }

  async decide(request: unknown, options: { correlationId?: string } = {}): Promise<PolicyDecision> {
    const correlationId = options.correlationId ?? crypto.randomUUID();
    const { decision, ruleId, grantId } = await this.#evaluate(request);
    await this.#audit.record(auditEvent(request, decision, ruleId, correlationId, grantId));
    return { decision, ruleId, correlationId, ...(grantId === undefined ? {} : { grantId }) };
  }

  async #evaluate(input: unknown): Promise<{ decision: Decision; ruleId: string; grantId?: string }> {
    const precheck = precheckAuthorization(input);
    if (!precheck.ok) {
      const ruleId = precheck.decision.effect !== "allow" && precheck.decision.reason === "cross-district"
        ? PSEUDO_RULE_IDS.crossDistrict
        : PSEUDO_RULE_IDS.invalidRequest;
      return { decision: precheck.decision, ruleId };
    }
    const request = precheck.request;
    const found = await this.#information.subjectFacts(request.subject.principalId);
    if (found === undefined || found.districtId !== request.subject.districtId) {
      return { decision: { effect: "deny", reason: "no-matching-grant" }, ruleId: PSEUDO_RULE_IDS.unknownSubject };
    }
    const at = this.#now();
    const facts: SubjectFacts = { ...found, roles: found.roles.filter((role) => roleAssignmentInForce(role, at)) };
    if (!(await this.#information.scopeExists(request.resource.scope))) {
      return { decision: { effect: "deny", reason: "no-matching-grant" }, ruleId: PSEUDO_RULE_IDS.unknownScope };
    }

    let policy: PolicySettings | undefined;
    let relationships: readonly RelationshipFact[] | undefined;
    const lookups: Lookups = {
      policy: async () => (policy ??= await this.#information.effectivePolicy(request.resource.scope)),
      // An inactive principal's roles end with its status, and so do its relationships.
      relationships: async () =>
        (relationships ??= facts.active ? await this.#information.relationships(request.subject.principalId, request.resource) : []),
    };
    for (const rule of this.#rules) {
      const match = await matches(rule.when, request, facts, lookups);
      if (match === false) continue;
      return { decision: rule.effect, ruleId: rule.id, ...(match.grantId === undefined ? {} : { grantId: match.grantId }) };
    }
    return { decision: { effect: "deny", reason: "no-matching-grant" }, ruleId: PSEUDO_RULE_IDS.noMatch };
  }
}

function includes<T>(allowed: readonly T[] | undefined, value: T | undefined): boolean {
  return allowed === undefined || (value !== undefined && allowed.includes(value));
}

function ownershipOf(request: AuthorizationRequest): Ownership {
  const owner = request.resource.ownerPrincipalId;
  if (owner === undefined) return "unowned";
  return owner === request.subject.principalId ? "own" : "others";
}

/** The facts a rule may need beyond the request and subject, each read at most once per decision. */
interface Lookups {
  policy(): Promise<PolicySettings>;
  relationships(): Promise<readonly RelationshipFact[]>;
}

/** Whether `when` matches, and if it named a relationship, the record that established it. */
async function matches(
  when: RuleCondition,
  request: AuthorizationRequest,
  facts: SubjectFacts,
  lookups: Lookups,
): Promise<false | { grantId?: string }> {
  const { action, resource, context } = request;
  if (
    !includes(when.principalKinds, facts.kind)
    || !includes(when.actions, action)
    || !includes(when.kinds, resource.kind)
    || !includes(when.classifications, resource.classification)
    || !includes(when.channels, context.channel)
    || !includes(when.termStates, context.termState)
    || !includes(when.ownership, ownershipOf(request))
  ) {
    return false;
  }
  if (
    when.roles !== undefined
    && !facts.roles.some((held) => when.roles!.includes(held.role) && scopeContains(held.scope, resource.scope))
  ) {
    return false;
  }
  if (when.policy !== undefined) {
    const policy = await lookups.policy();
    for (const [key, allowed] of Object.entries(when.policy) as [keyof PolicySettings, readonly unknown[] | undefined][]) {
      if (allowed !== undefined && !allowed.includes(policy[key])) return false;
    }
  }
  if (when.relationships !== undefined) {
    const held = (await lookups.relationships()).find((fact) => when.relationships!.includes(fact.relationship));
    return held === undefined ? false : { grantId: held.grantId };
  }
  return {};
}

/** The value if it parses, else nothing: lets a malformed request still be audited field by field. */
function field<S extends z.ZodType>(schema: S, value: unknown): z.output<S> | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** An identifier: no spaces or punctuation that prose would need, so free text is never copied as an ID. */
const RESOURCE_ID_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;

function auditEvent(input: unknown, decision: Decision, ruleId: string, correlationId: string, grantId: string | undefined): PolicyAuditEvent {
  // Read through optional chaining only: the input may be anything, and only identifiers and
  // vocabulary that parse are copied, so no content can reach the trail.
  const raw = input as
    | { subject?: { principalId?: unknown; districtId?: unknown }; action?: unknown; resource?: { kind?: unknown; id?: unknown }; context?: { channel?: unknown } }
    | null
    | undefined;
  const resourceId = typeof raw?.resource?.id === "string" && RESOURCE_ID_SHAPE.test(raw.resource.id)
    ? raw.resource.id
    : undefined;
  return PolicyAuditEvent.parse({
    correlationId,
    decidedAt: new Date().toISOString(),
    principalId: field(PrincipalId, raw?.subject?.principalId),
    districtId: field(DistrictId, raw?.subject?.districtId),
    action: field(Action, raw?.action),
    resourceKind: field(ResourceKind, raw?.resource?.kind),
    resourceId,
    channel: field(RequestChannel, raw?.context?.channel),
    effect: decision.effect,
    reason: decision.effect === "allow" ? undefined : decision.reason,
    ruleId,
    grantId,
  });
}
