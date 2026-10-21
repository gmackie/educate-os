import type { z } from "zod";
import {
  Action,
  DistrictId,
  precheckAuthorization,
  PrincipalId,
  RequestChannel,
  ResourceKind,
  scopeContains,
  type AuthorizationRequest,
  type Authorizer,
  type Decision,
  type PolicySettings,
} from "@schoolos/contracts";
import { PolicyAuditEvent, type PolicyAuditSink } from "./audit.ts";
import type { PolicyInformationPoint, SubjectFacts } from "./information.ts";
import { DEFAULT_DENY_RULE_ID, DEFAULT_POLICY_RULES, PolicyRuleTable, type Ownership, type PolicyRule, type RuleCondition } from "./rules.ts";

/** A decision with the rule that made it and the correlation ID it was audited under. */
export interface PolicyDecision {
  /** The decision. */
  decision: Decision;
  /** The rule that decided, as recorded in the audit event. */
  ruleId: string;
  /** The audit event's correlation ID. */
  correlationId: string;
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
}

/** The rule IDs recorded for decisions made before the rule table is consulted. */
export const PSEUDO_RULE_IDS = {
  invalidRequest: "precheck.invalid-request",
  crossDistrict: "precheck.cross-district",
  unknownSubject: "subject.unknown",
  noMatch: DEFAULT_DENY_RULE_ID,
} as const;

/**
 * The SchoolOS ABAC engine (roadmap A02). It runs `precheckAuthorization`, looks the subject up
 * through the policy information point, and then walks the rule table in order: the first rule
 * whose condition matches decides. A request no rule matches is denied with `no-matching-grant`.
 * Every decision, including prechecks, is written to the audit sink with the deciding rule's ID.
 */
export class PolicyEngine implements Authorizer, PolicyDecider {
  readonly #information: PolicyInformationPoint;
  readonly #audit: PolicyAuditSink;
  readonly #rules: readonly PolicyRule[];

  constructor(options: PolicyEngineOptions) {
    this.#information = options.information;
    this.#audit = options.audit;
    this.#rules = options.rules === undefined ? DEFAULT_POLICY_RULES : PolicyRuleTable.parse(options.rules);
  }

  async authorize(request: unknown): Promise<Decision> {
    return (await this.decide(request)).decision;
  }

  async decide(request: unknown, options: { correlationId?: string } = {}): Promise<PolicyDecision> {
    const correlationId = options.correlationId ?? crypto.randomUUID();
    const { decision, ruleId } = await this.#evaluate(request);
    await this.#audit.record(auditEvent(request, decision, ruleId, correlationId));
    return { decision, ruleId, correlationId };
  }

  async #evaluate(input: unknown): Promise<{ decision: Decision; ruleId: string }> {
    const precheck = precheckAuthorization(input);
    if (!precheck.ok) {
      const ruleId = precheck.decision.effect !== "allow" && precheck.decision.reason === "cross-district"
        ? PSEUDO_RULE_IDS.crossDistrict
        : PSEUDO_RULE_IDS.invalidRequest;
      return { decision: precheck.decision, ruleId };
    }
    const request = precheck.request;
    const facts = await this.#information.subjectFacts(request.subject.principalId);
    if (facts === undefined || facts.districtId !== request.subject.districtId) {
      return { decision: { effect: "deny", reason: "no-matching-grant" }, ruleId: PSEUDO_RULE_IDS.unknownSubject };
    }

    let policy: PolicySettings | undefined;
    const policyAt = async () => (policy ??= await this.#information.effectivePolicy(request.resource.scope));
    for (const rule of this.#rules) {
      if (await matches(rule.when, request, facts, policyAt)) return { decision: rule.effect, ruleId: rule.id };
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

async function matches(
  when: RuleCondition,
  request: AuthorizationRequest,
  facts: SubjectFacts,
  policyAt: () => Promise<PolicySettings>,
): Promise<boolean> {
  const { action, resource, context } = request;
  if (
    !includes(when.actions, action)
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
    const policy = await policyAt();
    for (const [key, allowed] of Object.entries(when.policy) as [keyof PolicySettings, readonly unknown[] | undefined][]) {
      if (allowed !== undefined && !allowed.includes(policy[key])) return false;
    }
  }
  return true;
}

/** The value if it parses, else nothing: lets a malformed request still be audited field by field. */
function field<S extends z.ZodType>(schema: S, value: unknown): z.output<S> | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** An identifier: no spaces or punctuation that prose would need, so free text is never copied as an ID. */
const RESOURCE_ID_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;

function auditEvent(input: unknown, decision: Decision, ruleId: string, correlationId: string): PolicyAuditEvent {
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
  });
}
