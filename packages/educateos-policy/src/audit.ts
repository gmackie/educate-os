import { z } from "zod";
import { Action, DecisionReason, DelegationId, DistrictId, PrincipalId, RequestChannel, ResourceKind } from "@educateos/contracts";

/**
 * One authorization decision as written to the audit trail (`policy_audit_event`, roadmap §10).
 * It names who asked, for what, the outcome, and the rule that decided it. It never carries
 * content: no resource body, prompt, tool argument or message, only identifiers and closed
 * vocabulary. Fields are absent when the request was too malformed to supply them.
 */
export const PolicyAuditEvent = z.strictObject({
  /** Links this decision to the caller's error body and to other decisions in the same invocation. */
  correlationId: z.string().min(1).max(128),
  /** When the decision was made. */
  decidedAt: z.iso.datetime(),
  /** The subject. */
  principalId: PrincipalId.optional(),
  /** The subject's district. */
  districtId: DistrictId.optional(),
  /** The requested action. */
  action: Action.optional(),
  /** The resource's kind. */
  resourceKind: ResourceKind.optional(),
  /** The resource's ID, absent for `create` and `list`. */
  resourceId: z.string().min(1).optional(),
  /** The channel the request arrived through. */
  channel: RequestChannel.optional(),
  /** The decision. */
  effect: z.enum(["allow", "deny", "require-approval"]),
  /** Why it was not simply allowed. */
  reason: DecisionReason.optional(),
  /** The rule that decided, or a `precheck.*` / `subject.*` / `scope.*` / `default.*` pseudo-rule. */
  ruleId: z.string().min(1),
  /** The record the deciding rule relied on, such as the appeal grant or share that allowed a read. */
  grantId: z.string().min(1).max(128).optional(),
  /** The delegation that bounded the request, when a client acted for the subject (SCHO-175). */
  delegationId: DelegationId.optional(),
});
/** A policy audit event. */
export type PolicyAuditEvent = z.infer<typeof PolicyAuditEvent>;

/**
 * Where audit events go. The engine awaits `record` before returning a decision, and a sink that
 * throws fails the authorization, so no decision takes effect unrecorded.
 */
export interface PolicyAuditSink {
  /** Stores one event. */
  record(event: PolicyAuditEvent): Promise<void>;
}

/** One recorded event and its position in the trail. */
export interface StoredPolicyAuditEvent {
  /** The event's position: strictly increasing in append order. */
  seq: number;
  /** The event. */
  event: PolicyAuditEvent;
}

/** The most events one {@link PolicyAuditReader.search} returns. */
export const MAX_AUDIT_SEARCH_PAGE = 100;

/**
 * How many recorded events one {@link PolicyAuditReader.search} looks at, at most, before it
 * returns what it found with a cursor to continue from. It bounds the cost of a narrow filter over
 * a long trail.
 */
export const MAX_AUDIT_SEARCH_SCAN = 5_000;

/**
 * Which decisions to find, newest first (SCHO-376). Every listed field must match; an omitted one
 * matches anything. It filters on identifiers and closed vocabulary only, as the trail holds.
 */
export const PolicyAuditQuery = z.strictObject({
  /** Only events recorded before this position: the previous page's `nextBefore`. */
  before: z.int().positive().optional(),
  /** How many events to return. */
  limit: z.int().min(1).max(MAX_AUDIT_SEARCH_PAGE),
  /** The decisions to find. */
  effects: z.array(PolicyAuditEvent.shape.effect).min(1).optional(),
  /** The deciding rule's ID, or its prefix ending in `.`, such as `admin.`. */
  rule: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(128).optional(),
  /** The subject. */
  principalId: PrincipalId.optional(),
  /** The requested actions. */
  actions: z.array(Action).min(1).optional(),
  /** The resource's kind. */
  resourceKind: ResourceKind.optional(),
});
/** A policy audit query. */
export type PolicyAuditQuery = z.infer<typeof PolicyAuditQuery>;

/** One page of a {@link PolicyAuditReader.search}. */
export interface PolicyAuditPage {
  /** The matching events, newest first. */
  entries: StoredPolicyAuditEvent[];
  /**
   * Where the next page starts (its query's `before`), or absent when the trail has nothing older.
   * A page may hold fewer than `limit` entries, even none, and still have a next page: a search
   * stops after {@link MAX_AUDIT_SEARCH_SCAN} events.
   */
  nextBefore?: number;
}

/** Reads the decision trail back, for a district administrator's audit screens (SCHO-376). */
export interface PolicyAuditReader {
  /** The newest events matching `query`, recorded before its `before`. */
  search(query: PolicyAuditQuery): Promise<PolicyAuditPage>;
}

/** Whether `event` is one `query` asks for. */
export function auditEventMatches(event: PolicyAuditEvent, query: PolicyAuditQuery): boolean {
  if (query.effects !== undefined && !query.effects.includes(event.effect)) return false;
  if (query.rule !== undefined && !(query.rule.endsWith(".") ? event.ruleId.startsWith(query.rule) : event.ruleId === query.rule)) return false;
  if (query.principalId !== undefined && event.principalId !== query.principalId) return false;
  if (query.actions !== undefined && (event.action === undefined || !query.actions.includes(event.action))) return false;
  if (query.resourceKind !== undefined && event.resourceKind !== query.resourceKind) return false;
  return true;
}

/**
 * Searches `events` (the whole trail, oldest first, each at position index + 1) as a durable
 * reader would: newest first, scanning at most {@link MAX_AUDIT_SEARCH_SCAN} events.
 */
export function searchAuditEvents(events: readonly PolicyAuditEvent[], query: PolicyAuditQuery): PolicyAuditPage {
  const parsed = PolicyAuditQuery.parse(query);
  const entries: StoredPolicyAuditEvent[] = [];
  let seq = Math.min(parsed.before ?? events.length + 1, events.length + 1) - 1;
  let scanned = 0;
  for (; seq >= 1 && entries.length < parsed.limit && scanned < MAX_AUDIT_SEARCH_SCAN; seq--, scanned++) {
    const event = events[seq - 1]!;
    if (auditEventMatches(event, parsed)) entries.push({ seq, event: structuredClone(event) });
  }
  return seq >= 1 ? { entries, nextBefore: seq + 1 } : { entries };
}

/** A {@link PolicyAuditSink} that keeps events in memory, in order: for tests and local harnesses. */
export class InMemoryPolicyAuditSink implements PolicyAuditSink, PolicyAuditReader {
  /** The events recorded so far. */
  readonly events: PolicyAuditEvent[] = [];

  async record(event: PolicyAuditEvent): Promise<void> {
    this.events.push(event);
  }

  async search(query: PolicyAuditQuery): Promise<PolicyAuditPage> {
    return searchAuditEvents(this.events, query);
  }
}
