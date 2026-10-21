import { EvidenceContractId } from "@schoolos/contracts";
import { z } from "zod";
import { CompetencyRef, Provenance } from "./primitives.ts";

/** The form a learner's response takes. Independent of how the activity is delivered. */
export const ResponseType = z.enum(["text", "file", "code", "audio", "video", "selection", "artifact"]);
/** A response type. */
export type ResponseType = z.infer<typeof ResponseType>;

/** One observable thing that counts as evidence, such as "names the independent variable". */
export const ObservableCriterion = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "expected a kebab-case criterion ID"),
  description: z.string().min(1).max(2000),
});
/** An observable criterion. */
export type ObservableCriterion = z.infer<typeof ObservableCriterion>;

/** The conditions a response must be produced under for it to count. */
export const AssessmentRestrictions = z.strictObject({
  aiAssistance: z.enum(["allowed", "allowed-with-disclosure", "not-allowed"]),
  collaboration: z.enum(["individual", "group"]),
  timeLimitMinutes: z.number().int().positive().max(24 * 60).optional(),
});
/** Assessment restrictions. */
export type AssessmentRestrictions = z.infer<typeof AssessmentRestrictions>;

/**
 * The claims and observations that count as evidence of one or more competencies (roadmap §5.1).
 * Each version is immutable, and an assessment run records the version it evaluated, so changing
 * the criteria never rewrites past results.
 */
export const EvidenceContract = z
  .strictObject({
    id: EvidenceContractId,
    version: z.number().int().positive(),
    title: z.string().min(1).max(500),
    competencies: z.array(CompetencyRef).min(1),
    responseType: ResponseType,
    criteria: z.array(ObservableCriterion).min(1),
    restrictions: AssessmentRestrictions,
    provenance: Provenance,
  })
  .refine((contract) => new Set(contract.criteria.map((c) => c.id)).size === contract.criteria.length, {
    path: ["criteria"],
    message: "criterion IDs must be unique",
  });
/** An evidence contract. */
export type EvidenceContract = z.infer<typeof EvidenceContract>;
