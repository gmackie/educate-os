// The kernel side of the optional AI call guard (`AI_CALL_GUARD`, see
// @gadgets/workshop-shared/ai-call-guard): every model call goes through admit() before it is
// sent and settle() after it ends. getModel() and getDecisionModel() apply the two wrappers below
// to everything they return, so this file is the one place to audit. With no guard bound, both
// wrappers return what they were given.

import type {
  AssistantMessage, ClassifierContext, ClassifierResult, Context,
  Message, Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AiCallDecision, AiCallDescriptor, AiCallGuard, AiCallMessage, AiCallMessagePart, AiCallOutcome,
  AiCallSite,
} from "@gadgets/workshop-shared/ai-call-guard";
import { createLogger } from "@gadgets/observability/logger";
import { AI_CALL_DENIED, AiCallDeniedError, zeroUsage } from "./ai-invoke.js";
import type { ModelHandle } from "./ai-models.js";

type GuardLogFields = { callId?: string; callSite?: string; reason?: string };
const logger = createLogger<GuardLogFields>({ component: "workshop.ai-call-guard" });

/** The two guard methods the kernel calls. */
export type AiCallGuardClient = Pick<AiCallGuard, "beforeModelCall" | "afterModelCall">;

/** What every call through one handle has in common: everything but the call and its messages. */
export type AiCallScope = Omit<AiCallDescriptor,
    "callId" | "logicalRequestId" | "kind" | "maxOutputTokens" | "newMessages">;

// The ids of the messages each scope (a call site in one chat, or in one workspace outside a chat)
// has already passed to the guard in a call it let proceed, oldest first. Held for the isolate's
// lifetime and bounded, so it only ever forgets: a forgotten message is passed again, which the
// guard's at-least-once contract allows, while an unseen one is never skipped. Keyed by content
// rather than position, because replay and compaction rebuild each turn's transcript.
const MAX_SCOPES = 256;
const MAX_MESSAGES_PER_SCOPE = 4096;
const passedByScope = new Map<string, Set<string>>();

// The steps of a chat's agent turns replay one transcript whatever started each turn, so they share
// one record: a turn with a new label passes only what is new, not the whole history again.
const AGENT_TURN_SITES = new Set<AiCallSite>([
  "chat.message", "chat.external", "chat.steer", "agent.callback", "agent.spawn", "chat.agent",
  "chat.compaction",
]);

function passedMessages(scope: AiCallScope): Set<string> {
  if (scope.gadgetId === undefined) return new Set();
  let site = AGENT_TURN_SITES.has(scope.callSite) ? "agent-turn" : scope.callSite;
  let key = `${site}:${scope.gadgetId}:${scope.chatId ?? ""}`;
  let passed = passedByScope.get(key) ?? new Set();
  // Most recently used last, so the oldest scope is the first evicted.
  passedByScope.delete(key);
  passedByScope.set(key, passed);
  if (passedByScope.size > MAX_SCOPES) {
    passedByScope.delete(passedByScope.keys().next().value!);
  }
  return passed;
}

function remember(passed: Set<string>, ids: string[]) {
  for (let id of ids) {
    passed.add(id);
    if (passed.size > MAX_MESSAGES_PER_SCOPE) passed.delete(passed.values().next().value!);
  }
}

async function sha256(text: string): Promise<string> {
  let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest).toHex();
}

async function describeMessage(
    role: AiCallMessage["role"], content: Message["content"],
    toolName?: string): Promise<AiCallMessage> {
  let parts: AiCallMessagePart[] = [];
  let blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  for (let part of blocks) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      parts.push({ type: "image", mimeType: part.mimeType, digest: await sha256(part.data) });
    }
  }
  return {
    id: await sha256(JSON.stringify([role, toolName ?? null, parts])),
    role, ...(toolName !== undefined ? { toolName } : {}), parts,
  };
}

// A transcript is append-only within a turn, so each step passes the previous steps' message
// objects again; this saves rehashing them.
const describedMessages = new WeakMap<Message, AiCallMessage>();

// The messages of `context` a model did not write: its caller-supplied system prompt (a gadget's,
// through its LLM binding), user messages and tool results. The Workshop's own system messages and
// the model's responses are left out.
async function describeContext(context: Context): Promise<AiCallMessage[]> {
  let described: AiCallMessage[] = [];
  if (context.systemPrompt) {
    described.push(await describeMessage("system", context.systemPrompt));
  }
  for (let message of context.messages) {
    if (message.role !== "user" && message.role !== "toolResult") continue;
    let known = describedMessages.get(message);
    if (!known) {
      known = message.role === "user"
          ? await describeMessage("user", message.content)
          : await describeMessage("toolResult", message.content, message.toolName);
      describedMessages.set(message, known);
    }
    described.push(known);
  }
  return described;
}

/** How long a guard may take to decide before the call is denied. */
const GUARD_DECISION_TIMEOUT_MS = 15_000;

// Settles with the guard's decision, or rejects once the call is aborted or the guard takes longer
// than GUARD_DECISION_TIMEOUT_MS, so a hung guard can neither stall a turn nor outlive its Stop.
function decisionWithin(
    decision: Promise<AiCallDecision>, signal: AbortSignal | undefined): Promise<AiCallDecision> {
  let deadline = AbortSignal.timeout(GUARD_DECISION_TIMEOUT_MS);
  let stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return new Promise((resolve, reject) => {
    if (stop.aborted) return reject(stop.reason);
    stop.addEventListener("abort", () => reject(stop.reason), { once: true });
    decision.then(resolve, reject);
  });
}

/**
 * Asks the guard whether the call `call` describes may run, passing the messages of `messages` not
 * yet passed for its scope. Returns the call's id, or the denial. A guard that fails, times out or
 * is still deciding when the call is aborted denies.
 */
async function admit(
    guard: AiCallGuardClient, scope: AiCallScope,
    call: Pick<AiCallDescriptor, "kind" | "maxOutputTokens">,
    messages: AiCallMessage[], signal?: AbortSignal): Promise<{ callId: string } | AiCallDeniedError> {
  let passed = passedMessages(scope);
  let newMessages = messages.filter(message => !passed.has(message.id));
  let callId = crypto.randomUUID();
  let logicalRequestId = await sha256(JSON.stringify(
      [scope.callSite, scope.gadgetId ?? null, scope.chatId ?? null, messages.map(m => m.id)]));
  let decision: AiCallDecision;
  try {
    decision = await decisionWithin(guard.beforeModelCall(
        { ...scope, ...call, callId, logicalRequestId, newMessages }), signal);
  } catch (error) {
    logger.error("AI call guard failed; denying the call", {
      event: "ai_call_guard.before.failed", callId, callSite: scope.callSite, error,
    });
    return new AiCallDeniedError(
        "This request could not be checked, so it was not sent. Try again later.",
        "guard_unavailable");
  }
  if (decision.action !== "proceed") {
    let reason = decision.action === "deny" ? decision.reason : "invalid_decision";
    logger.info("AI call guard denied a model call", {
      event: "ai_call_guard.denied", callId, callSite: scope.callSite, reason,
    });
    return new AiCallDeniedError(
        decision.action === "deny" ? decision.message : "This request was not allowed.", reason);
  }
  remember(passed, newMessages.map(message => message.id));
  return { callId };
}

// Reports how an admitted call ended. Not awaited by the call: the request's own pending I/O keeps
// the Durable Object it runs in alive until this finishes.
function settle(guard: AiCallGuardClient, outcome: AiCallOutcome) {
  guard.afterModelCall(outcome).catch((error: unknown) => {
    logger.warn("AI call guard failed to settle a model call", {
      event: "ai_call_guard.after.failed", callId: outcome.callId, error,
    });
  });
}

function reportedUsage(usage: Usage | undefined): AiCallOutcome["usage"] {
  return usage && { input: usage.input, output: usage.output,
                    cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
}

/**
 * Makes `handle.stream` consult `guard` around every request, as one from `scope`'s call site
 * unless the request names its own (ModelStreamOptions.callSite). A denied request is never sent:
 * its stream ends at once with an error response that throwIfAiCallDenied() recognizes. Returns
 * `handle` itself, modified, so `lastResponse` stays where the handle's own stream writes it.
 */
export function guardModelHandle(
    guard: AiCallGuardClient | undefined, handle: ModelHandle, scope: AiCallScope): ModelHandle {
  if (!guard) return handle;
  let stream = handle.stream;
  handle.stream = (model, context, { callSite, ...options } = {}) => {
    let callScope = callSite ? { ...scope, callSite } : scope;
    let guarded = createAssistantMessageEventStream();
    let fail = (errorMessage: string, denial?: AiCallDeniedError) => {
      let error: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: zeroUsage(), stopReason: "error", errorMessage, timestamp: Date.now(),
        ...(denial ? { diagnostics: [{ type: AI_CALL_DENIED, timestamp: Date.now(),
                                        details: { reason: denial.reason } }] } : {}),
      };
      guarded.push({ type: "error", reason: "error", error });
    };
    void (async () => {
      let admitted = await admit(guard, callScope,
          { kind: "language-model", maxOutputTokens: options.maxTokens ?? model.maxTokens },
          await describeContext(context), options.signal);
      if (admitted instanceof AiCallDeniedError) return fail(admitted.message, admitted);
      let response: AssistantMessage | undefined;
      try {
        let inner = stream(model, context, options);
        for await (let event of inner) guarded.push(event);
        response = await inner.result();
      } finally {
        let aiGatewayLogId = handle.lastResponse?.aiGatewayLogId;
        settle(guard, {
          callId: admitted.callId,
          status: response?.stopReason === "aborted" ? "aborted"
              : response === undefined || response.stopReason === "error" ? "failed"
              : "completed",
          usage: reportedUsage(response?.usage),
          ...(aiGatewayLogId !== undefined ? { aiGatewayLogId } : {}),
        });
      }
    })().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    return guarded;
  };
  return handle;
}

/** Runs one resolved decision model (see getDecisionModel()). */
export type DecisionModel = (context: ClassifierContext) => Promise<ClassifierResult>;

/**
 * Makes `decide` consult `guard` around every call, passing the decision's state and questions as
 * one user message. A denied call throws AiCallDeniedError without reaching the model.
 */
export function guardDecisionModel(
    guard: AiCallGuardClient | undefined, decide: DecisionModel,
    scope: AiCallScope): DecisionModel {
  if (!guard) return decide;
  return async context => {
    let request = await describeMessage(
        "user", JSON.stringify({ state: context.state, questions: context.questions }));
    let admitted = await admit(guard, scope, { kind: "decision-model" }, [request]);
    if (admitted instanceof AiCallDeniedError) throw admitted;
    let result: ClassifierResult | undefined;
    try {
      result = await decide(context);
      return result;
    } finally {
      settle(guard, {
        callId: admitted.callId,
        status: result?.stopReason === "stop" ? "completed"
            : result?.stopReason === "aborted" ? "aborted" : "failed",
        usage: reportedUsage(result?.usage),
      });
    }
  };
}
