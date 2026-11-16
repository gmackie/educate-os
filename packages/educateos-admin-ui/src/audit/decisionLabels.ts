// How the audit screens name the decision trail's closed vocabulary (SCHO-376). Rule IDs are shown
// as they are: they are what the district's rule table and its documentation name.
import type { RouteResponse } from "@educateos/api-client";

/** One decision as the district lists it. */
export type DecisionEntry = RouteResponse<"admin.decisionLog">["entries"][number];

/** What an outcome reads as, and its badge. */
export const EFFECT_LABELS: Readonly<Record<DecisionEntry["effect"], { label: string; variant: "success" | "error" | "warning" }>> = {
  allow: { label: "Allowed", variant: "success" },
  deny: { label: "Refused", variant: "error" },
  "require-approval": { label: "Held for approval", variant: "warning" },
};

const REASONS: Readonly<Record<NonNullable<DecisionEntry["reason"]>, string>> = {
  "no-matching-grant": "No rule allows it",
  "cross-district": "Another district's record",
  "owner-only": "Only its owner",
  "classification-restricted": "Too sensitive for this person",
  "term-not-active": "The term is not open",
  "policy-floor": "A district policy forbids it",
  "requires-teacher-review": "Waits for a teacher's review",
  "invalid-request": "Malformed request",
};

/** Why a decision was not simply allowed. */
export const reasonLabel = (reason: NonNullable<DecisionEntry["reason"]>): string => REASONS[reason];

/** A kebab-case code as words: `capability-config` reads "Capability config". */
export const words = (code: string): string => {
  const spaced = code.replaceAll("-", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const CHANNELS: Readonly<Record<NonNullable<DecisionEntry["channel"]>, string>> = {
  http: "Web",
  "mcp-tool": "Tool (MCP)",
  agent: "AI agent",
  system: "System",
  "lti-service": "LTI tool",
};

/** The surface a request arrived through. */
export const channelLabel = (channel: NonNullable<DecisionEntry["channel"]>): string => CHANNELS[channel];

/** The record kinds the filters offer, in the order an administrator looks for them. */
export const FILTER_KINDS = [
  "principal", "enrollment", "offering", "school", "term", "course", "district", "capability-config", "ai-budget",
  "guardian-relationship", "identity-link", "access-grant", "delegation", "official-grade", "submission", "artifact",
  "discussion-post", "audit-event",
] as const satisfies readonly NonNullable<DecisionEntry["resourceKind"]>[];
