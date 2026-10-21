import { PrincipalId, SchoolOsError } from "@schoolos/contracts";
import { z } from "zod";
import { ContentItemId } from "./ids.ts";

/**
 * Where a content item stands in the ingest pipeline (roadmap §5.3). Nothing is usable by a class
 * before `released`: earlier states hold untrusted, unapproved content.
 */
export const PipelineState = z.enum([
  "discovered",
  "quarantined",
  "parsed",
  "provenance-resolved",
  "reviewed",
  "approved",
  "rejected",
  "released",
  "published",
]);
/** A pipeline state. */
export type PipelineState = z.infer<typeof PipelineState>;

/**
 * The transitions the pipeline allows. Each state moves only forward. A quarantined item can be
 * rejected without review when its malware scan fails; otherwise only a reviewer rejects.
 */
export const TRANSITIONS: Readonly<Record<PipelineState, readonly PipelineState[]>> = {
  discovered: ["quarantined"],
  quarantined: ["parsed", "rejected"],
  parsed: ["provenance-resolved"],
  "provenance-resolved": ["reviewed"],
  reviewed: ["approved", "rejected"],
  approved: ["released"],
  rejected: [],
  released: ["published"],
  published: [],
};

/** The states in which an item's content may be bound to a class. */
export const USABLE_STATES: readonly PipelineState[] = ["released", "published"];

/**
 * Checks that `from → to` is an allowed transition.
 *
 * @throws SchoolOsError `conflict` otherwise.
 */
export function assertTransition(from: PipelineState, to: PipelineState): void {
  if (!TRANSITIONS[from].includes(to)) throw new SchoolOsError("conflict", `an item cannot move from ${from} to ${to}`);
}

/** What happened in an audit event. */
export const AuditEventType = z.enum(["transition", "rights-changed", "bound"]);
/** An audit event type. */
export type AuditEventType = z.infer<typeof AuditEventType>;

/**
 * One audit event. Events record who did what and when, and never content: no page text,
 * excerpt or reviewer output, so the audit trail can be read by administrators who are not
 * cleared to see the content itself.
 */
export const StudioAuditEvent = z.strictObject({
  itemId: ContentItemId,
  type: AuditEventType,
  /** The principal who acted, or `system` for pipeline steps that run on import. */
  actor: z.union([PrincipalId, z.literal("system")]),
  at: z.iso.datetime({ offset: true }),
  from: PipelineState.optional(),
  to: PipelineState.optional(),
  /** A short, content-free note such as a rights change (`link → embed`) or a refusal reason code. */
  detail: z.string().max(500).optional(),
});
/** A studio audit event. */
export type StudioAuditEvent = z.infer<typeof StudioAuditEvent>;
