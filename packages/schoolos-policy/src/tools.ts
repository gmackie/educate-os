import { z } from "zod";
import {
  SchoolOsError,
  type Action,
  type AuthorizationRequest,
  type RequestChannel,
  type ResourceRef,
  type SchoolOsErrorBody,
  type TermState,
  type VerifiedPrincipal,
} from "@schoolos/contracts";
import {
  DeclineReason,
  ToolApprovalId,
  toolCallKey,
  type PendingToolAction,
  type ToolApprovalNeed,
  type ToolApprovalStore,
} from "./approvals.ts";
import type { PolicyDecider } from "./engine.ts";

/** The channels a school tool is invoked through. */
export type ToolChannel = "mcp-tool" | "agent";

/** The trusted context of one tool invocation. */
export interface SchoolToolContext {
  /** The verified principal the call acts for. A principal named in the input is only a selector. */
  principal: VerifiedPrincipal;
  /** How the call arrived. */
  channel: ToolChannel;
  /** The correlation ID every decision and error of this invocation carries. */
  correlationId: string;
}

/** The resource a call acts on, built from stored records, with its term's state if it has one. */
export interface ToolTarget {
  /** The resource. */
  resource: ResourceRef;
  /** The state of the term it belongs to. */
  termState?: TermState;
}

/** The definition {@link defineSchoolTool} accepts. */
export interface SchoolToolDefinition<S extends z.ZodObject, R> {
  /** A snake_case name, unique within a runner. */
  name: string;
  /** What the tool does, for tool listings. */
  description: string;
  /** The arguments. Must be a strict object: unknown fields are rejected, never ignored. */
  inputSchema: S;
  /** The action every call is authorized as. */
  action: Action;
  /**
   * Resolves the target from validated input and the trusted context, by looking up stored
   * records. Returns `undefined` when there is no such resource, which the caller sees exactly as
   * a denied read.
   */
  resource(input: z.output<S>, context: SchoolToolContext): Promise<ToolTarget | undefined>;
  /** Does the work. Runs only after the engine allows the call. */
  handler(input: z.output<S>, context: SchoolToolContext): Promise<R>;
  /**
   * MCP tool annotations such as `readOnlyHint`, passed through to listings for clients. The
   * runner never reads them: `action` alone is what gets authorized.
   */
  annotations?: Readonly<Record<string, unknown>>;
}

/** A defined school tool, as a runner holds it. */
export interface SchoolTool {
  /** The tool name. */
  readonly name: string;
  /** What the tool does. */
  readonly description: string;
  /** The strict argument schema. */
  readonly inputSchema: z.ZodObject;
  /** The action every call is authorized as. */
  readonly action: Action;
  /** Resolves the target. */
  resource(input: unknown, context: SchoolToolContext): Promise<ToolTarget | undefined>;
  /** Does the work. */
  handler(input: unknown, context: SchoolToolContext): Promise<unknown>;
  /** Listing-only annotations. */
  readonly annotations?: Readonly<Record<string, unknown>>;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Defines a tool every call of which is validated and re-authorized by a {@link SchoolToolRunner}.
 * Throws if the name is malformed or the input schema would accept unknown fields.
 */
export function defineSchoolTool<S extends z.ZodObject, R>(definition: SchoolToolDefinition<S, R>): SchoolTool {
  if (!TOOL_NAME.test(definition.name)) throw new Error(`invalid tool name ${definition.name}`);
  if (definition.inputSchema.def.catchall?._zod.def.type !== "never") {
    throw new Error(`tool ${definition.name} must use z.strictObject for its input`);
  }
  const { name, description, inputSchema, action, annotations } = definition;
  return {
    name,
    description,
    inputSchema,
    action,
    ...(annotations === undefined ? {} : { annotations }),
    // The runner passes only what `inputSchema` produced.
    resource: (input, context) => definition.resource(input as z.output<S>, context),
    handler: (input, context) => definition.handler(input as z.output<S>, context),
  };
}

/** A tool's listing entry. */
export interface SchoolToolListing {
  /** The tool name. */
  name: string;
  /** What it does. */
  description: string;
  /** The arguments as a JSON Schema document. */
  inputSchema: Record<string, unknown>;
  /** Listing-only annotations. */
  annotations?: Readonly<Record<string, unknown>>;
}

/**
 * The outcome of one invocation. `approval-required` means the call did nothing yet: a person must
 * decide it first. With an approval queue configured it names the queued action and why it waits.
 * Neither it nor an error says why the engine refused; that is in the audit entry the correlation
 * ID names.
 */
export type SchoolToolOutcome =
  | { status: "ok"; value: unknown; correlationId: string }
  | { status: "approval-required"; correlationId: string; approvalId?: ToolApprovalId; needs?: ToolApprovalNeed }
  | { status: "error"; error: SchoolOsErrorBody };

/** How a {@link SchoolToolRunner} queues calls that wait for a person (SCHO-55). */
export interface ToolApprovalOptions {
  /** Where queued actions are kept. */
  store: ToolApprovalStore;
  /** How long a queued action stays approvable. Defaults to {@link DEFAULT_APPROVAL_TTL_MS}. */
  ttlMs?: number;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** How long a queued action stays approvable by default: one week. */
export const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A person deciding a queued action. `principal` must come from verified authentication. Only the
 * `http` channel decides: no tool or agent channel can approve or decline anything.
 */
export interface DecisionSession {
  /** The verified principal deciding. */
  principal: VerifiedPrincipal;
  /** How the decision arrived. */
  channel: RequestChannel;
}

/**
 * The outcome of an approval or decline. `already-applied` answers an approval of an action that
 * has already run, so a retried approval never runs it twice.
 */
export type ToolDecisionOutcome =
  | { status: "applied"; approvalId: ToolApprovalId; value: unknown; correlationId: string }
  | { status: "already-applied"; approvalId: ToolApprovalId; correlationId: string }
  | { status: "declined"; approvalId: ToolApprovalId; correlationId: string }
  | { status: "error"; error: SchoolOsErrorBody };

/** Actions a refusal of which answers `not-found`: the caller may not know the resource exists. */
const READ_LIKE: ReadonlySet<Action> = new Set<Action>(["read", "list", "export"]);

/**
 * Runs school tools for verified sessions (roadmap §8, ADR-0005). For every call it:
 *
 * 1. rejects a tool name it does not hold;
 * 2. parses the arguments with the tool's strict schema, rejecting unknown fields;
 * 3. resolves the target from stored records and asks the engine, with the session's principal as
 *    the subject — nothing in the arguments or the tool's annotations reaches the request;
 * 4. runs the handler only on `allow`.
 *
 * A refused read, or a refused write to something the caller cannot read, answers `not-found`,
 * the same as a resource that does not exist. A refused write to something the caller can read
 * answers `forbidden`.
 */
export class SchoolToolRunner {
  readonly #tools: ReadonlyMap<string, SchoolTool>;
  readonly #engine: PolicyDecider;
  readonly #approvals: Required<ToolApprovalOptions> | undefined;

  constructor(options: { tools: readonly SchoolTool[]; engine: PolicyDecider; approvals?: ToolApprovalOptions }) {
    const tools = new Map<string, SchoolTool>();
    for (const tool of options.tools) {
      if (tools.has(tool.name)) throw new Error(`duplicate tool name ${tool.name}`);
      tools.set(tool.name, tool);
    }
    this.#tools = tools;
    this.#engine = options.engine;
    this.#approvals = options.approvals === undefined
      ? undefined
      : { ttlMs: DEFAULT_APPROVAL_TTL_MS, now: () => new Date(), ...options.approvals };
  }

  /** The tools, for an MCP `tools/list` response. */
  list(): SchoolToolListing[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    }));
  }

  /**
   * Invokes one tool. `session` must come from verified authentication; `name` and `args` are
   * untrusted model or client output.
   *
   * With an approval queue, a `require-approval` decision queues the call for someone the policy
   * lets approve it. `confirmWrites` also queues every allowed call whose action is not a read, for
   * the requester to confirm as a person: that is how an agent's writes wait for a human.
   */
  async invoke(
    session: { principal: VerifiedPrincipal; channel: ToolChannel },
    name: unknown,
    args: unknown,
    options: { confirmWrites?: boolean } = {},
  ): Promise<SchoolToolOutcome> {
    if (options.confirmWrites === true && this.#approvals === undefined) {
      throw new Error("confirmWrites needs an approval queue");
    }
    const correlationId = crypto.randomUUID();
    const tool = typeof name === "string" ? this.#tools.get(name) : undefined;
    if (tool === undefined) {
      return failure("not-found", "There is no such tool.", correlationId);
    }
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return failure("validation-failed", describeIssues(parsed.error), correlationId);
    }
    const context: SchoolToolContext = { principal: session.principal, channel: session.channel, correlationId };
    try {
      const target = await tool.resource(parsed.data, context);
      if (target === undefined) return failure("not-found", "The requested resource was not found.", correlationId);

      const { decision } = await this.#engine.decide(requestFor(context, tool.action, target), { correlationId });
      if (decision.effect === "require-approval") {
        if (this.#approvals === undefined) return { status: "approval-required", correlationId };
        return await this.#enqueue(context, tool, parsed.data, "approval");
      }
      if (decision.effect === "deny") return await this.#refusal(context, tool.action, target);
      if (options.confirmWrites === true && !READ_LIKE.has(tool.action)) {
        return await this.#enqueue(context, tool, parsed.data, "confirmation");
      }
      return { status: "ok", value: await tool.handler(parsed.data, context), correlationId };
    } catch (error) {
      if (error instanceof SchoolOsError) return { status: "error", error: { ...error.toBody(), correlationId } };
      // The caller gets nothing internal, so this line is the only record of what went wrong.
      console.error("school tool failed", { tool: tool.name, correlationId, error });
      return failure("unavailable", "The tool could not complete the request.", correlationId);
    }
  }

  /**
   * Approves a queued action and runs it, at most once, for the subject that queued it. Before it
   * runs, the requester's own call is decided again against current facts, so a change the
   * requester may no longer make is declined rather than applied. A `confirmation` is decided by
   * the requester; an `approval` by someone the engine lets `approve` the resource.
   */
  async approve(session: DecisionSession, approvalId: unknown): Promise<ToolDecisionOutcome> {
    const correlationId = crypto.randomUUID();
    const found = await this.#openForDecision(session, approvalId, correlationId);
    if ("outcome" in found) return found.outcome;
    const { action, tool, input, target } = found;
    if (!(await this.#mayDecide(session, action, target, correlationId))) {
      return this.#deciderRefusal(session, action, correlationId);
    }

    const approvals = this.#queue();
    const claimed = { ...action, state: "claimed" as const };
    if (!(await approvals.store.transition(action.id, "pending", claimed))) {
      return await this.#settled(action.id, correlationId);
    }
    const context: SchoolToolContext = { principal: action.subject, channel: action.channel, correlationId: action.correlationId };
    let value: unknown;
    try {
      value = await tool.handler(input, context);
    } catch (error) {
      // As in gatekeeper-kit, a handler that throws is retryable: the action waits again.
      await approvals.store.transition(action.id, "claimed", action);
      if (error instanceof SchoolOsError) return { status: "error", error: { ...error.toBody(), correlationId } };
      console.error("approved school tool failed", { tool: tool.name, correlationId, error });
      return failure("unavailable", "The change could not be applied. It is still waiting for a decision.", correlationId);
    }
    const applied: PendingToolAction = { ...action, state: "applied", decidedBy: session.principal.principalId, decidedAt: approvals.now().toISOString() };
    await approvals.store.transition(action.id, "claimed", applied);
    return { status: "applied", approvalId: action.id, value, correlationId };
  }

  /**
   * Declines a queued action with a reason. The requester may withdraw their own; otherwise only
   * someone who could approve it may decline it.
   */
  async decline(session: DecisionSession, approvalId: unknown, reason: unknown): Promise<ToolDecisionOutcome> {
    const correlationId = crypto.randomUUID();
    const parsedReason = DeclineReason.safeParse(reason);
    if (!parsedReason.success) return failure("validation-failed", "A decline needs a reason of 1 to 500 characters.", correlationId);
    const found = await this.#openForDecision(session, approvalId, correlationId);
    if ("outcome" in found) return found.outcome;
    const { action, target } = found;
    if (!isRequester(session, action) && !(await this.#mayDecide(session, action, target, correlationId))) {
      return this.#deciderRefusal(session, action, correlationId);
    }
    if (session.channel !== "http") return failure("forbidden", "Only a person can decline this.", correlationId);
    const approvals = this.#queue();
    const declined: PendingToolAction = {
      ...action,
      state: "declined",
      decidedBy: session.principal.principalId,
      decidedAt: approvals.now().toISOString(),
      declineReason: parsedReason.data,
    };
    if (!(await approvals.store.transition(action.id, "pending", declined))) {
      return await this.#settled(action.id, correlationId);
    }
    return { status: "declined", approvalId: action.id, correlationId };
  }

  /**
   * The open actions `session` requested or may approve, oldest first. Each is re-authorized, so a
   * teacher dropped from a class stops seeing its queue on the next call.
   */
  async pendingFor(session: DecisionSession): Promise<PendingToolAction[]> {
    const approvals = this.#queue();
    const correlationId = crypto.randomUUID();
    const visible: PendingToolAction[] = [];
    for (const action of await approvals.store.list()) {
      if (action.state !== "pending" || this.#isExpired(action)) continue;
      if (isRequester(session, action)) {
        visible.push(action);
        continue;
      }
      const resolved = await this.#resolveQueued(action);
      if (resolved !== undefined && (await this.#mayDecide(session, action, resolved.target, correlationId))) visible.push(action);
    }
    return visible;
  }

  /** Marks every pending action past its expiry as expired. Returns how many it expired. */
  async expireDue(): Promise<number> {
    const approvals = this.#queue();
    let expired = 0;
    for (const action of await approvals.store.list()) {
      if (action.state === "pending" && this.#isExpired(action) && (await this.#expire(action))) expired += 1;
    }
    return expired;
  }

  #queue(): Required<ToolApprovalOptions> {
    if (this.#approvals === undefined) throw new Error("this runner has no approval queue");
    return this.#approvals;
  }

  async #enqueue(context: SchoolToolContext, tool: SchoolTool, input: unknown, needs: ToolApprovalNeed): Promise<SchoolToolOutcome> {
    const approvals = this.#queue();
    const now = approvals.now();
    const call = { subject: context.principal, channel: context.channel, tool: tool.name, input: input as PendingToolAction["input"] };
    const candidate: PendingToolAction = {
      ...call,
      id: ToolApprovalId.parse(`apr_${crypto.randomUUID()}`),
      correlationId: context.correlationId,
      needs,
      idempotencyKey: await toolCallKey(call),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + approvals.ttlMs).toISOString(),
      state: "pending",
    };
    let stored = await approvals.store.insertUnlessOpen(candidate);
    // An identical call still open but past its expiry is expired, so this one queues afresh.
    if (stored.id !== candidate.id && stored.state === "pending" && this.#isExpired(stored)) {
      await this.#expire(stored);
      stored = await approvals.store.insertUnlessOpen(candidate);
    }
    return { status: "approval-required", correlationId: context.correlationId, approvalId: stored.id, needs: stored.needs };
  }

  /**
   * Finds a pending action and everything needed to decide it, or the outcome to answer instead.
   * Someone who neither requested nor decided an action learns nothing about it: `not-found`, as
   * for an ID that was never issued.
   */
  async #openForDecision(session: DecisionSession, approvalId: unknown, correlationId: string): Promise<
    | { outcome: ToolDecisionOutcome }
    | { action: PendingToolAction; tool: SchoolTool; input: unknown; target: ToolTarget }
  > {
    const approvals = this.#queue();
    const notFound = { outcome: failure("not-found", "There is no such request.", correlationId) as ToolDecisionOutcome };
    const id = ToolApprovalId.safeParse(approvalId);
    if (!id.success) return notFound;
    const action = await approvals.store.get(id.data);
    if (action === undefined) return notFound;
    if (action.state !== "pending") {
      return isRequester(session, action) || action.decidedBy === session.principal.principalId
        ? { outcome: await this.#settled(action.id, correlationId) }
        : notFound;
    }
    if (this.#isExpired(action)) {
      await this.#expire(action);
      return isRequester(session, action) ? { outcome: failure("conflict", "This request has expired.", correlationId) } : notFound;
    }

    const resolved = await this.#resolveQueued(action);
    if (resolved === undefined) {
      // The tool, its schema or the resource has gone since the call was queued: it cannot run.
      await this.#declineAutomatically(action, "The request can no longer be carried out.");
      return isRequester(session, action) ? { outcome: failure("conflict", "The request can no longer be carried out.", correlationId) } : notFound;
    }
    // The requester's call, decided again now: a change they may no longer make is not applied.
    const requester: SchoolToolContext = { principal: action.subject, channel: action.channel, correlationId };
    const { decision } = await this.#engine.decide(requestFor(requester, resolved.tool.action, resolved.target), { correlationId });
    if (decision.effect === "deny") {
      await this.#declineAutomatically(action, "The change is no longer permitted.");
      return isRequester(session, action) ? { outcome: failure("forbidden", "The change is no longer permitted.", correlationId) } : notFound;
    }
    // A confirmation whose call the engine now holds for approval needs an approver after all.
    const current = decision.effect === "require-approval" ? { ...action, needs: "approval" as const } : action;
    return { action: current, ...resolved };
  }

  async #resolveQueued(action: PendingToolAction): Promise<{ tool: SchoolTool; input: unknown; target: ToolTarget } | undefined> {
    const tool = this.#tools.get(action.tool);
    if (tool === undefined) return undefined;
    const parsed = tool.inputSchema.safeParse(action.input);
    if (!parsed.success) return undefined;
    const context: SchoolToolContext = { principal: action.subject, channel: action.channel, correlationId: action.correlationId };
    const target = await tool.resource(parsed.data, context);
    return target === undefined ? undefined : { tool, input: parsed.data, target };
  }

  async #mayDecide(session: DecisionSession, action: PendingToolAction, target: ToolTarget, correlationId: string): Promise<boolean> {
    if (session.channel !== "http") return false;
    if (action.needs === "confirmation") return isRequester(session, action);
    const request: AuthorizationRequest = {
      subject: session.principal,
      action: "approve",
      resource: target.resource,
      context: { channel: session.channel, ...(target.termState === undefined ? {} : { termState: target.termState }) },
    };
    return (await this.#engine.decide(request, { correlationId })).decision.effect === "allow";
  }

  #deciderRefusal(session: DecisionSession, action: PendingToolAction, correlationId: string): ToolDecisionOutcome {
    if (!isRequester(session, action)) return failure("not-found", "There is no such request.", correlationId);
    if (session.channel !== "http") return failure("forbidden", "Only a person can decide this request.", correlationId);
    return failure("forbidden", "Someone with authority over this resource must approve it.", correlationId);
  }

  /** Answers for an action that is no longer pending. */
  async #settled(id: ToolApprovalId, correlationId: string): Promise<ToolDecisionOutcome> {
    const action = await this.#queue().store.get(id);
    if (action === undefined) return failure("not-found", "There is no such request.", correlationId);
    switch (action.state) {
      case "applied":
        return { status: "already-applied", approvalId: id, correlationId };
      case "declined":
        return failure("conflict", "This request was declined.", correlationId);
      case "expired":
        return failure("conflict", "This request has expired.", correlationId);
      case "claimed":
        return failure("conflict", "This request is being applied.", correlationId);
      case "pending":
        return failure("conflict", "This request changed while it was being decided. Try again.", correlationId);
    }
  }

  #isExpired(action: PendingToolAction): boolean {
    return this.#queue().now().getTime() >= Date.parse(action.expiresAt);
  }

  async #expire(action: PendingToolAction): Promise<boolean> {
    const expired: PendingToolAction = { ...action, state: "expired", decidedAt: this.#queue().now().toISOString() };
    return await this.#queue().store.transition(action.id, "pending", expired);
  }

  async #declineAutomatically(action: PendingToolAction, reason: string): Promise<void> {
    const declined: PendingToolAction = { ...action, state: "declined", decidedAt: this.#queue().now().toISOString(), declineReason: reason };
    await this.#queue().store.transition(action.id, "pending", declined);
  }

  async #refusal(context: SchoolToolContext, action: Action, target: ToolTarget): Promise<SchoolToolOutcome> {
    if (READ_LIKE.has(action) || !(await this.#mayRead(context, target))) {
      return failure("not-found", "The requested resource was not found.", context.correlationId);
    }
    return failure("forbidden", `You may not ${action} this ${target.resource.kind}.`, context.correlationId);
  }

  async #mayRead(context: SchoolToolContext, target: ToolTarget): Promise<boolean> {
    const { decision } = await this.#engine.decide(requestFor(context, "read", target), { correlationId: context.correlationId });
    return decision.effect === "allow";
  }
}

function requestFor(context: SchoolToolContext, action: Action, target: ToolTarget): AuthorizationRequest {
  return {
    subject: context.principal,
    action,
    resource: target.resource,
    context: {
      channel: context.channel,
      ...(target.termState === undefined ? {} : { termState: target.termState }),
    },
  };
}

function isRequester(session: DecisionSession, action: PendingToolAction): boolean {
  return session.principal.principalId === action.subject.principalId && session.principal.districtId === action.subject.districtId;
}

function failure(code: SchoolOsErrorBody["code"], message: string, correlationId: string): { status: "error"; error: SchoolOsErrorBody } {
  return { status: "error", error: { code, message, correlationId } };
}

/** Names each invalid field and why, without echoing any submitted value. */
function describeIssues(error: z.ZodError): string {
  const issues = error.issues.map((issue) =>
    issue.code === "unrecognized_keys"
      ? `unknown field(s) ${issue.keys.join(", ")}`
      : `${issue.path.join(".") || "(arguments)"}: ${issue.code}`
  );
  return `The tool arguments are invalid: ${issues.join("; ")}`.slice(0, 1000);
}
