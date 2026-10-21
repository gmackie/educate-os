import { z } from "zod";
import { aiHelpLayersAt, type AiHelpLevel, type DesiredState } from "@schoolos/config";
import {
  compareUsdNano,
  POLICY_ORDERINGS,
  PositiveUsdNano,
  UsdNano,
  type ActivityId,
  type CapabilityManifest,
  type PlatformResource,
  type Scope,
} from "@schoolos/contracts";
import { ExecutionProfileId } from "@schoolos/assessment-ci";
import { ModelRef } from "./model-port.ts";

/** The most a profile may let one run spend: $100, in nanodollars. */
export const MAX_RUN_COST_USD_NANO = "100000000000";
const withinRunCostCeiling = (amount: string) => compareUsdNano(amount, MAX_RUN_COST_USD_NANO) <= 0;

/**
 * How an AI assessment run executes (roadmap §7): one model, and the limits on tokens, the size of
 * the work sent, cost and retries. The cost limit, in nanodollars (ADR-0008), is what governance
 * reserves before the request.
 */
export const AiExecutionProfile = z.strictObject({
  id: ExecutionProfileId,
  kind: z.literal("ai"),
  model: ModelRef,
  limits: z.strictObject({
    /** The most characters of submitted text sent to the model; a longer submission is skipped, never truncated. */
    maxInputChars: z.int().positive().max(400_000),
    maxOutputTokens: z.int().positive().max(32_000),
    maxCostUsdNano: PositiveUsdNano.refine(withinRunCostCeiling, "expected at most $100"),
    maxRetries: z.int().nonnegative().max(5),
  }),
});
/** An AI execution profile. */
export type AiExecutionProfile = z.infer<typeof AiExecutionProfile>;

/** Hosts an allowlist may name: lowercase DNS names, no ports, paths or wildcards. */
const EgressHost = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "expected a host name such as data.example");

/**
 * The isolation an executable check runs under. Every limit is enforced by the sandbox itself, not
 * by the code it runs. See `docs/schoolos/assessment-sandbox.md` for how each maps to Cloudflare.
 *
 * - `cpuMs`: CPU time for the whole job.
 * - `memoryMb`: the most memory the job may hold at once.
 * - `maxOutputBytes`: the most the job may write to stdout and stderr together.
 * - `egress`: `none`, or only the listed hosts.
 * - `maxCostUsdNano`: the most the run may spend across all its checks, in nanodollars.
 */
export const CiSandboxProfile = z.strictObject({
  runtime: z.enum(["python-3", "node-22"]),
  cpuMs: z.int().positive().max(600_000),
  memoryMb: z.int().positive().max(4096),
  maxOutputBytes: z.int().positive().max(1024 * 1024),
  egress: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({ kind: z.literal("allowlist"), hosts: z.array(EgressHost).min(1).max(20) }),
  ]),
  maxCostUsdNano: UsdNano.refine(withinRunCostCeiling, "expected at most $100"),
});
/** A CI sandbox profile. */
export type CiSandboxProfile = z.infer<typeof CiSandboxProfile>;

/** How a sandboxed assessment run executes. */
export const SandboxExecutionProfile = z.strictObject({
  id: ExecutionProfileId,
  kind: z.literal("sandbox"),
  sandbox: CiSandboxProfile,
  maxRetries: z.int().nonnegative().max(5),
});
/** A sandbox execution profile. */
export type SandboxExecutionProfile = z.infer<typeof SandboxExecutionProfile>;

/** An optional (non-deterministic) execution profile. */
export const OptionalExecutionProfile = z.discriminatedUnion("kind", [AiExecutionProfile, SandboxExecutionProfile]);
/** An optional execution profile. */
export type OptionalExecutionProfile = z.infer<typeof OptionalExecutionProfile>;

/**
 * What the district's plan includes. The sandbox is not on every plan (roadmap §7), and a
 * sandboxed run where it is not fails closed.
 */
export const DistrictAssessmentPlan = z.strictObject({ sandbox: z.enum(["available", "unavailable"]) });
/** A district assessment plan. */
export type DistrictAssessmentPlan = z.infer<typeof DistrictAssessmentPlan>;

/** The installed Assessment CI pack, as the district's configuration and installer record it. */
export interface InstalledAssessmentPack {
  /** The pack's manifest: what it declares it can use. */
  manifest: Pick<CapabilityManifest, "optionalResources">;
  /** The optional resources the installer provisioned for it. */
  provisionedOptionalResources: readonly PlatformResource[];
}

/**
 * The district plan, read from the installed capability pack (roadmap §4) instead of being
 * asserted by a caller: the sandbox is available only where the pack declares `ci-sandbox` among
 * its `optionalResources` **and** the district provisioned it. A resource provisioned for a pack
 * that never asked for it does not count.
 */
export function assessmentPlanFromPack(
  manifest: Pick<CapabilityManifest, "optionalResources">,
  provisionedOptionalResources: readonly PlatformResource[],
): DistrictAssessmentPlan {
  const declared = manifest.optionalResources?.includes("ci-sandbox") ?? false;
  return { sandbox: declared && provisionedOptionalResources.includes("ci-sandbox") ? "available" : "unavailable" };
}

/**
 * Whether an activity allows AI feedback on its work:
 * - `none`: no AI looks at the work; AI runs are skipped.
 * - `teacher-only`: AI feedback is advice to the teacher and is never released to the student.
 * - `releasable`: the teacher may release reviewed AI feedback to the student.
 *
 * {@link activityAiHelpPolicies} reads it from the curriculum's installed activity (C05).
 */
export const AiHelpPolicy = z.enum(["none", "teacher-only", "releasable"]);
/** An AI-help policy. */
export type AiHelpPolicy = z.infer<typeof AiHelpPolicy>;

/** Where an activity's AI-help policy comes from. An activity with none is treated as `none`. */
export interface AiHelpPolicySource {
  aiHelpPolicy(activityId: ActivityId): Promise<AiHelpPolicy | undefined>;
}

/** {@link AiHelpPolicy} values from least to most restrictive. */
const FEEDBACK_ORDER: readonly AiHelpPolicy[] = ["releasable", "teacher-only", "none"];

/**
 * The most an AI-help level allows. AI feedback on a student's work is help with the work itself, so
 * only `full` lets it reach the student; under `hints-only` it stays advice to the teacher.
 */
const FEEDBACK_CEILING: Readonly<Record<AiHelpLevel, AiHelpPolicy>> = {
  full: "releasable",
  "hints-only": "teacher-only",
  none: "none",
};

/**
 * An activity's AI-help policy, capped by the district's compiled configuration (F03): its own
 * policy from `activities`, tightened to what the strictest AI-help level at or above its offering
 * allows. An activity whose offering cannot be found has no policy, which the service reads as
 * `none`. `readConfig` returns the applied head revision's desired state, or `undefined` before the
 * first one.
 */
export function compiledConfigAiHelpPolicies(input: {
  activities: AiHelpPolicySource;
  offeringOf(activityId: ActivityId): Promise<Extract<Scope, { level: "offering" }> | undefined>;
  readConfig(): Promise<DesiredState | undefined>;
}): AiHelpPolicySource {
  return {
    async aiHelpPolicy(activityId) {
      const [own, offering] = await Promise.all([input.activities.aiHelpPolicy(activityId), input.offeringOf(activityId)]);
      if (own === undefined || offering === undefined) return undefined;
      const { district, school, offering: offeringLevel } = aiHelpLayersAt(await input.readConfig(), offering);
      const order: readonly AiHelpLevel[] = POLICY_ORDERINGS.aiHelp;
      const level = [district, school, offeringLevel]
        .filter((l) => l !== undefined)
        .reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a));
      const ceiling = FEEDBACK_CEILING[level];
      return FEEDBACK_ORDER.indexOf(own) >= FEEDBACK_ORDER.indexOf(ceiling) ? own : ceiling;
    },
  };
}
