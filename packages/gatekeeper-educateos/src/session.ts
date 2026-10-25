// The agent-facing session, apart from the Worker's entrypoints so it runs, and is tested, under
// Node. It holds no authority of its own: the subject comes from the connected account, reads are
// recorded as observations before their data is returned, and every write becomes a change a
// person must approve in the Workshop.
import type { EducateOsErrorBody, VerifiedPrincipal } from "@educateos/contracts";
import type { ToolDecisionOutcome } from "@educateos/policy";
import type { SchoolToolService } from "./district.ts";

/** A read the agent is about to receive, for the Workshop's activity log. */
export interface SchoolRead {
  /** The tool. */
  tool: string;
  /** The arguments as the agent sent them. */
  args: Record<string, unknown>;
  /** The district's correlation ID for the call. */
  correlationId: string;
}

/** A change the district queued, for the Workshop's approval queue. */
export interface SchoolChange extends SchoolRead {
  /** The district's ID for the queued change. */
  approvalId: string;
  /** Whether the requester confirms it or someone with authority over the resource approves it. */
  needs: "approval" | "confirmation";
}

/** What a session runs against. The Worker supplies these from its account and approval queue. */
export interface SchoolToolsHost {
  /** The district's tools. */
  district: SchoolToolService;
  /**
   * The principal the connected account was verified as when it was connected. Throws if the
   * account has been revoked. This is the only source of the subject.
   */
  account(): Promise<VerifiedPrincipal>;
  /** Records a read; returning means the agent may receive it. Throws to withhold it. */
  observe(read: SchoolRead): Promise<void>;
  /** Submits a queued change for a person's decision. It must never be auto-approvable. */
  submit(change: SchoolChange): Promise<void>;
}

/** A tool as the agent sees it. Annotations such as `readOnlyHint` are not passed on. */
export interface SchoolToolInfo {
  /** The tool's name. */
  name: string;
  /** What it does. */
  description: string;
  /** The arguments, as a JSON Schema document. Unknown fields are rejected. */
  inputSchema: Record<string, unknown>;
}

/** The result of one tool call, in the agent-facing shape `types.d.ts` documents. */
export type SchoolToolCallResult =
  | { status: "ok"; value: unknown; correlationId: string }
  | { status: "awaiting-decision"; correlationId: string }
  | { status: "error"; code: EducateOsErrorBody["code"]; message: string; correlationId?: string };

/** The agent-facing school tools session (`SchoolToolsSession` in `types.d.ts`). */
export class SchoolToolsSessionCore {
  readonly #host: SchoolToolsHost;

  constructor(host: SchoolToolsHost) {
    this.#host = host;
  }

  /** The district's tools. */
  async listTools(): Promise<SchoolToolInfo[]> {
    return (await this.#host.district.listTools()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  /**
   * Calls one tool as the connected account's principal. `name` and `args` are untrusted: the
   * district validates them, and nothing in them can name who is asking.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<SchoolToolCallResult> {
    const subject = await this.#host.account();
    const outcome = await this.#host.district.callTool(subject, name, args);
    switch (outcome.status) {
      case "ok":
        // A write never answers `ok` here: the district queues every one. So this is a read.
        await this.#host.observe({ tool: name, args, correlationId: outcome.correlationId });
        return outcome;
      case "approval-required":
        if (outcome.approvalId === undefined || outcome.needs === undefined) {
          return { status: "error", code: "unavailable", message: "This school's changes cannot be approved here.", correlationId: outcome.correlationId };
        }
        await this.#host.submit({ tool: name, args, correlationId: outcome.correlationId, approvalId: outcome.approvalId, needs: outcome.needs });
        return { status: "awaiting-decision", correlationId: outcome.correlationId };
      case "error":
        return { status: "error", ...outcome.error };
    }
  }
}

/**
 * What a person's decision in the Workshop came to.
 *
 * - `done`: the change applied (now or by an earlier approval), or was declined.
 * - `refused`: it will not apply from here, for a reason safe to show the person.
 * - `retry`: it failed for a reason that may pass, and is still waiting.
 */
export type DecisionResult = { kind: "done" } | { kind: "refused"; message: string } | { kind: "retry"; message: string };

/** Classifies the district's answer to a decision the Workshop forwarded. */
export function decisionResult(outcome: ToolDecisionOutcome): DecisionResult {
  if (outcome.status !== "error") return { kind: "done" };
  const { code, message } = outcome.error;
  return code === "unavailable" ? { kind: "retry", message } : { kind: "refused", message };
}
