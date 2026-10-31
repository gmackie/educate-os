import { z } from "zod";
import type { RequestChannel } from "./authorization.ts";

// The vocabulary of an operation descriptor (RFC 0002 §2, SCHO-173): what a REST route, an MCP or
// agent tool, an LTI service call and a trusted job all read from one definition, so no surface
// decides for itself what an operation is, who may reach it through which door, or what it does.

/**
 * The doors an operation can be exposed through. An operation lists the ones it accepts; a call
 * through any other is refused by design, before its input is read.
 *
 * - `ui`: the district's own screens.
 * - `rest`: the district's HTTP API, including the screens' calls to it.
 * - `mcp-agent`: an MCP client or agent acting for a verified principal.
 * - `lti-service`: a registered LTI tool's service call (EducateOS as LTI Platform).
 * - `internal-job`: a trusted background job under a service identity.
 */
export const OperationChannel = z.enum(["ui", "rest", "mcp-agent", "lti-service", "internal-job"]);
/** An operation channel. */
export type OperationChannel = z.infer<typeof OperationChannel>;

/**
 * What an operation does to records, which decides whether a call needs confirming and how a
 * curated surface classifies it.
 *
 * - `read`: changes nothing.
 * - `draft`: a change only its author and reviewers see until it is published.
 * - `publish`: a change others see or rely on, including any direct write to a record of record.
 * - `approve`: a person's decision that makes something official, such as a grade.
 * - `export`: copies records out of EducateOS.
 * - `delete`: removes records.
 */
export const OperationEffect = z.enum(["read", "draft", "publish", "approve", "export", "delete"]);
/** An operation effect. */
export type OperationEffect = z.infer<typeof OperationEffect>;

/**
 * What repeating a call does. `inherent`: repeating it changes nothing more (reads, and writes that
 * set a value). `none`: repeating it repeats the effect, such as creating a second record.
 * `keyed`: the caller must send an idempotency key, and a repeat with the same key is the first
 * call's result.
 */
export const OperationIdempotency = z.enum(["inherent", "none", "keyed"]);
/** An operation's idempotency. */
export type OperationIdempotency = z.infer<typeof OperationIdempotency>;

/**
 * Who must agree before an allowed call takes effect. `none`: nobody. `confirm-agent`: a call on
 * the `mcp-agent` channel waits until the requester confirms it as a person. `approver`: every
 * call waits for someone the policy lets `approve` the target. An approval is never something a
 * call's input can carry.
 */
export const ApprovalPolicy = z.enum(["none", "confirm-agent", "approver"]);
/** An approval policy. */
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

/**
 * Metered spend an operation incurs, which a funding pool must admit before it runs. Only AI
 * activities carry one.
 */
export const OperationBudget = z.strictObject({
  /** What is metered. */
  meter: z.literal("ai-model"),
  /** The most model calls one invocation may make. */
  maxCalls: z.int().positive().optional(),
});
/** An operation budget. */
export type OperationBudget = z.infer<typeof OperationBudget>;

/**
 * The descriptor fields every surface reads, apart from the operation's schemas and handler.
 * `name` is stable within a `version`; a change in meaning is a new version.
 */
export const OperationDescriptorFields = z.strictObject({
  /** The descriptor's version. */
  version: z.int().positive(),
  /** What the operation does to records. */
  effect: OperationEffect,
  /** The channels it is exposed through. */
  channels: z.array(OperationChannel).min(1),
  /** What repeating a call does. */
  idempotency: OperationIdempotency,
  /** Who must agree before a call takes effect. */
  approval: ApprovalPolicy,
  /** Metered spend, for AI activities. */
  budget: OperationBudget.optional(),
});
/** The descriptor fields of an operation. Its channel list is never changed once defined. */
export type OperationDescriptorFields = Omit<z.infer<typeof OperationDescriptorFields>, "channels"> & {
  readonly channels: readonly OperationChannel[];
};

/**
 * Checks the rules every descriptor must keep, throwing on the first broken one, so a malformed
 * descriptor fails when it is defined rather than when it is called:
 *
 * - a `read` repeats harmlessly and needs nobody's approval;
 * - an `approve` or `delete` is never exposed to `mcp-agent` (RFC 0002 §2's curated-MCP
 *   exclusions): a person makes those decisions through a separately authenticated surface;
 * - a channel is listed once.
 */
export function assertOperationDescriptor(name: string, fields: OperationDescriptorFields): void {
  const { version, effect, channels, idempotency, approval, budget } = fields;
  OperationDescriptorFields.parse({ version, effect, channels, idempotency, approval, ...(budget === undefined ? {} : { budget }) });
  if (fields.effect === "read" && (fields.idempotency !== "inherent" || fields.approval !== "none")) {
    throw new Error(`operation ${name} reads, so it must be inherently idempotent and need no approval`);
  }
  if ((fields.effect === "approve" || fields.effect === "delete") && fields.channels.includes("mcp-agent")) {
    throw new Error(`operation ${name} is an ${fields.effect}, which is never exposed to mcp-agent`);
  }
  if (new Set(fields.channels).size !== fields.channels.length) {
    throw new Error(`operation ${name} lists a channel twice`);
  }
}

/**
 * The operation channel a request on `channel` arrives through. An HTTP request is `rest`: the
 * district's screens call its HTTP API too, so `ui` cannot be told apart from `rest` yet. MCP tool
 * and agent calls are both `mcp-agent`, and a `system` call is a trusted `internal-job`.
 */
export function operationChannelFor(channel: RequestChannel): OperationChannel {
  switch (channel) {
    case "http":
      return "rest";
    case "mcp-tool":
    case "agent":
      return "mcp-agent";
    case "system":
      return "internal-job";
  }
}
