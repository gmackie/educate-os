import { z } from "zod";
import { DistrictId, PrincipalId, UtcTimestamp } from "@schoolos/contracts";
import type { ToolChannel } from "./tools.ts";

/** The ID of a queued tool action: `apr_` and an opaque body. It may belong in contracts later. */
export const ToolApprovalId = z.string().regex(/^apr_[a-z0-9][a-z0-9-]{0,62}$/, "expected a tool approval ID");
/** A tool approval ID. */
export type ToolApprovalId = z.infer<typeof ToolApprovalId>;

/**
 * Why a queued tool action waits.
 *
 * - `approval`: the engine answered `require-approval`, so someone the policy lets `approve` the
 *   resource must decide (for an official grade, a teacher of the offering over http).
 * - `confirmation`: the engine allowed the write, but it came from an agent whose writes a person
 *   must confirm first. Only the requester, deciding as a person over http, confirms it.
 */
export const ToolApprovalNeed = z.enum(["approval", "confirmation"]);
/** Why a queued tool action waits. */
export type ToolApprovalNeed = z.infer<typeof ToolApprovalNeed>;

/**
 * Where a queued action is in its life, following gatekeeper-kit's action journal: `pending` waits
 * for a decision; `claimed` has its handler running, so a second approval cannot run it again;
 * `applied`, `declined` and `expired` are final. A handler that throws returns its action to
 * `pending`, so it can be approved again.
 */
export const ToolApprovalState = z.enum(["pending", "claimed", "applied", "declined", "expired"]);
/** A queued action's state. */
export type ToolApprovalState = z.infer<typeof ToolApprovalState>;

/** The states an action can still be decided from. */
export const OPEN_APPROVAL_STATES: ReadonlySet<ToolApprovalState> = new Set<ToolApprovalState>(["pending", "claimed"]);

/** The channels a queued call can have arrived through: only tool channels queue calls. */
export const QueuedToolChannel = z.enum(["mcp-tool", "agent"]) satisfies z.ZodType<ToolChannel>;

/** What a decline records about why. Shown to the requester, so it must not carry other people's data. */
export const DeclineReason = z.string().trim().min(1).max(500);

/**
 * One tool call waiting for a person. It holds the call exactly as it will run: the tool, the
 * input as the tool's schema produced it, the verified subject it runs for and the channel and
 * correlation ID of the call that queued it.
 */
export const PendingToolAction = z.strictObject({
  /** The action's ID. */
  id: ToolApprovalId,
  /** The tool's name. */
  tool: z.string().min(1).max(64),
  /** The validated input. It is parsed again with the tool's schema before it runs. */
  input: z.json(),
  /** The verified principal the call runs for. */
  subject: z.strictObject({ principalId: PrincipalId, districtId: DistrictId }),
  /** The channel the call arrived through. */
  channel: QueuedToolChannel,
  /** The correlation ID of the call that queued it, which its decisions were audited under. */
  correlationId: z.string().min(1).max(128),
  /** Why it waits. */
  needs: ToolApprovalNeed,
  /**
   * Identifies the call: the same subject, channel, tool and input give the same key, so queueing
   * a call that is already open returns the open action instead of a second one.
   */
  idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
  /** When it was queued. */
  createdAt: UtcTimestamp,
  /** When it stops being approvable. */
  expiresAt: UtcTimestamp,
  /** Where it is in its life. */
  state: ToolApprovalState,
  /** Who approved or declined it. */
  decidedBy: PrincipalId.optional(),
  /** When it was approved, declined or expired. */
  decidedAt: UtcTimestamp.optional(),
  /** Why it was declined. */
  declineReason: DeclineReason.optional(),
});
/** A queued tool action. */
export type PendingToolAction = z.infer<typeof PendingToolAction>;

/**
 * Where queued tool actions are kept. Every write is a compare-and-set, so two approvals racing
 * for one action cannot both run it. A Durable Object or database implementation keeps each method
 * atomic, as {@link InMemoryToolApprovalStore} does.
 */
export interface ToolApprovalStore {
  /** The action, or `undefined`. */
  get(id: ToolApprovalId): Promise<PendingToolAction | undefined>;
  /**
   * Stores `action` unless an open action (pending or claimed) has its idempotency key, and
   * returns whichever is now stored for that key.
   */
  insertUnlessOpen(action: PendingToolAction): Promise<PendingToolAction>;
  /** Replaces the action with `next` only if it is still in state `from`. Reports whether it did. */
  transition(id: ToolApprovalId, from: ToolApprovalState, next: PendingToolAction): Promise<boolean>;
  /** Every action, oldest first. */
  list(): Promise<PendingToolAction[]>;
}

/** A {@link ToolApprovalStore} in memory. Values are copied in and out, so callers share no state. */
export class InMemoryToolApprovalStore implements ToolApprovalStore {
  readonly #actions = new Map<ToolApprovalId, PendingToolAction>();

  async get(id: ToolApprovalId): Promise<PendingToolAction | undefined> {
    const action = this.#actions.get(id);
    return action === undefined ? undefined : structuredClone(action);
  }

  async insertUnlessOpen(action: PendingToolAction): Promise<PendingToolAction> {
    const parsed = PendingToolAction.parse(action);
    for (const stored of this.#actions.values()) {
      if (stored.idempotencyKey === parsed.idempotencyKey && OPEN_APPROVAL_STATES.has(stored.state)) {
        return structuredClone(stored);
      }
    }
    if (this.#actions.has(parsed.id)) throw new Error(`duplicate tool approval ID ${parsed.id}`);
    this.#actions.set(parsed.id, parsed);
    return structuredClone(parsed);
  }

  async transition(id: ToolApprovalId, from: ToolApprovalState, next: PendingToolAction): Promise<boolean> {
    const stored = this.#actions.get(id);
    if (stored === undefined || stored.state !== from) return false;
    const parsed = PendingToolAction.parse(next);
    if (parsed.id !== id) throw new Error("a transition cannot change an action's ID");
    this.#actions.set(id, parsed);
    return true;
  }

  async list(): Promise<PendingToolAction[]> {
    return [...this.#actions.values()].map((action) => structuredClone(action));
  }
}

/**
 * The idempotency key of a call: a SHA-256 over its subject, channel, tool and input, with object
 * keys sorted so the same input in another key order gives the same key.
 */
export async function toolCallKey(call: Pick<PendingToolAction, "subject" | "channel" | "tool" | "input">): Promise<string> {
  const canonical = canonicalJson([call.subject.districtId, call.subject.principalId, call.channel, call.tool, call.input]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
