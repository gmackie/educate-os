import { z } from "zod";
import { OfferingId, PrincipalId } from "@educateos/contracts";
import { PriceBook } from "@educateos/ai-governance";

/** Deployment-only pilot policy. Absence or enabled:false disables model calls. */
export const PlannerRuntimePolicy = z.strictObject({
  enabled: z.boolean().default(false),
  gatewayId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  offeringIds: z.array(OfferingId).min(1).max(100),
  /** District-confirmed guardian authorization for AI processing, required at every grade. */
  grants: z.array(z.strictObject({
    studentId: PrincipalId,
    grantedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), revokedAt: z.iso.datetime().optional(),
    guardianAuthorized: z.literal(true),
  }).refine((g) => Date.parse(g.expiresAt) > Date.parse(g.grantedAt))).max(500),
  maxRequestsPerStudentDay: z.int().min(1).max(20).default(5),
  priceBook: PriceBook,
});
/** Validated deployment policy. No browser or model may write this policy. */
export type PlannerRuntimePolicy = z.infer<typeof PlannerRuntimePolicy>;

