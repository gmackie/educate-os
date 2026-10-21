import type { WorkerEntrypoint } from "cloudflare:workers";
import type { AiChatAuthorInfo, AiModelProvider } from "./api";

/**
 * Where in the Workshop a model call comes from. Every language-model and decision-model request
 * carries one, so a guard can apply a different policy to, say, an agent step and a chat title.
 */
export type AiCallSite =
  /** A step of an agent turn on a chat, including the turn's compaction requests. */
  | "chat.agent"
  /** The title generated for a new chat from its first message. */
  | "chat.title"
  /** The workspace title generated from a chat's log. */
  | "gadget.title"
  /** A binding name chosen for a resource the agent or user connected. */
  | "chat.binding-name"
  /** A call through a gadget's language-model binding. */
  | "gadget.llm"
  /** A call through a gadget's decision-model binding. */
  | "gadget.decision"
  /** An admin's test of a gateway model. */
  | "admin.model-test"
  /** A call from a site that names none; a guard should treat it as the strictest case. */
  | "unattributed";

/** One part of a message passed to the guard: its text, or a reference to an attachment. */
export type AiCallMessagePart =
  | { type: "text"; text: string }
  /**
   * An image or PDF attachment, by reference. `digest` is the hex SHA-256 of the attachment's
   * base64 data as the model receives it; the bytes themselves are not sent.
   */
  | { type: "image"; mimeType: string; digest: string };

/**
 * A message about to reach a model that the guard has not been shown before for the same chat. Only
 * content a model did not produce is passed: user messages, tool results (which carry external
 * data) and a caller-supplied system prompt. Assistant messages and the Workshop's own system
 * messages are not.
 */
export type AiCallMessage = {
  /**
   * Hex SHA-256 of the message's role, tool name and parts. The same content always has the same
   * id, so a guard can cache its verdict by it.
   */
  id: string;
  /** Who the message is from, in the model transcript's terms. */
  role: "system" | "user" | "toolResult";
  /** The tool whose result this is, for a `toolResult` message. */
  toolName?: string;
  /** The message's text and attachment references, in order. */
  parts: AiCallMessagePart[];
};

/**
 * Content-free description of one model call, plus the messages new to the guard. Passed to
 * {@link AiCallGuard.beforeModelCall} before the request is sent.
 */
export type AiCallDescriptor = {
  /** Unique to this attempt. {@link AiCallOutcome.callId} names it again. */
  callId: string;
  /**
   * The same for attempts that send the same context in the same scope (a retried request), and
   * different for the next step of a turn. Best-effort: settle budgets by `callId`, not by this.
   */
  logicalRequestId: string;
  /** Whether the call streams from a language model or asks a decision model. */
  kind: "language-model" | "decision-model";
  /** Where the call comes from. */
  callSite: AiCallSite;
  /**
   * Who the call is made for. For `type: "gadget"`, `id` is the gadget's owner. Asserted by the
   * Workshop, which authenticated it.
   */
  initiator: Pick<AiChatAuthorInfo, "type" | "id">;
  /** The workspace the call belongs to, when it belongs to one. */
  gadgetId?: string;
  /** The chat the call belongs to, when it belongs to one. */
  chatId?: number;
  /** The configured model the call runs. */
  model: { provider: AiModelProvider; id: string };
  /** The response cap the request asks for, when it has one: the most output it can bill. */
  maxOutputTokens?: number;
  /**
   * The messages of this request the guard has not been shown for this chat (or, outside a chat,
   * this workspace's call site). The Workshop guarantees at-least-once: no message reaches a model
   * without having been passed here in a call the guard let proceed, but one may be passed again,
   * for example after the Workshop restarts or when a replay renders it differently. Never logged
   * by the Workshop.
   */
  newMessages: AiCallMessage[];
};

/** The guard's answer to {@link AiCallGuard.beforeModelCall}. */
export type AiCallDecision =
  /** Send the request. */
  | { action: "proceed" }
  /**
   * Do not send it. The request fails as a model failure would, before reaching the provider.
   */
  | {
      action: "deny";
      /** Machine-readable reason, e.g. `"budget_exhausted"`. Logged; must hold no message text. */
      reason: string;
      /** Shown to the user in place of the model's response. */
      message: string;
    };

/**
 * Token usage of a call, as its provider reported it. The counts are disjoint: `input` excludes the
 * cached prompt tokens counted in `cacheRead` and `cacheWrite`, so the prompt's total is their sum,
 * and `output` includes any reasoning tokens.
 */
export type AiCallUsage = {
  /** Prompt tokens read neither from nor into the provider's cache. */
  input: number;
  /** Response tokens, reasoning included. */
  output: number;
  /** Prompt tokens read from the provider's cache. */
  cacheRead: number;
  /** Prompt tokens written to the provider's cache. */
  cacheWrite: number;
};

/** How a call the guard let proceed ended. Passed to {@link AiCallGuard.afterModelCall}. */
export type AiCallOutcome = {
  /** The {@link AiCallDescriptor.callId} of the call. */
  callId: string;
  /** Whether the model answered, the request failed, or it was cancelled. */
  status: "completed" | "failed" | "aborted";
  /**
   * What the provider reported, which for a failed or cancelled call may be partial or zero.
   * Absent when the provider reported none.
   */
  usage?: AiCallUsage;
  /** The AI Gateway log of the request, when it went through one; its cost can be read there. */
  aiGatewayLogId?: string;
};

/**
 * An optional deployment-provided service, bound to the Workshop backend as `AI_CALL_GUARD`, that
 * the backend consults around every model call: to reserve and settle a budget, and to moderate the
 * new messages before a model reads them. When it is not bound, model calls run unguarded.
 */
export interface AiCallGuard extends WorkerEntrypoint {
  /**
   * Called before each model request is sent, including each step of an agent turn. A rejection
   * counts as a denial: a configured guard is mandatory, so the call fails closed.
   */
  beforeModelCall(call: AiCallDescriptor): Promise<AiCallDecision>;

  /**
   * Called once each call that the guard let proceed has ended. Not awaited by the request: a
   * failure here is logged and does not affect the call.
   */
  afterModelCall(outcome: AiCallOutcome): Promise<void>;
}
