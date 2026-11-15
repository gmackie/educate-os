// Optional, teacher-initiated, district-governed model adapter for a private
// pedagogical-intent suggestion. No student records, instructor notes or raw
// lesson body are passed to this interface. No default remote provider exists.
import type { ModelRef, TokenUsage } from "@educateos/ai-governance";
import type { UsdNano } from "@educateos/contracts";

/** Bounded, non-student source metadata: all fields are from a verified OCS plan. */
export interface CourseIntentPrompt {
  source: { packageId: string; version: string; digest: string; unitKey: string };
  title: string;
  summary: string;
  learningStandards: { frameworkKey: string; competencyUri: string }[];
  goal: "low-equipment" | "language-scaffolding" | "accessibility-first" | "hands-on-practice";
  /** Adapter MUST bound its generation and treat all course fields as untrusted data. */
  maxOutputTokens: 750;
}

/**
 * The district controls which provider/model is available, its expected maximum
 * reservation, pricing and inference. This is not supplied by a browser request.
 * A real adapter MUST use its own trusted provider credentials and report a
 * complete, accurate usage/cost result to the district governor.
 */
export interface CourseIntentProvider {
  model: ModelRef;
  /** Highest amount this adapter could bill for the bounded request. */
  estimatedMaxUsdNano: UsdNano;
  generate(input: CourseIntentPrompt): Promise<{
    intent: unknown;
    usage: TokenUsage;
    actualUsdNano: UsdNano;
  }>;
}
