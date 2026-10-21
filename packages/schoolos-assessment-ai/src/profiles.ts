import { z } from "zod";
import type { ActivityId } from "@schoolos/contracts";
import { ExecutionProfileId } from "@schoolos/assessment-ci";
import { ModelRef } from "./model-port.ts";

/**
 * How an AI assessment run executes (roadmap §7): one model, and the limits on tokens, the size of
 * the work sent, cost and retries. The cost limit is what governance reserves before the request.
 */
export const AiExecutionProfile = z.strictObject({
  id: ExecutionProfileId,
  kind: z.literal("ai"),
  model: ModelRef,
  limits: z.strictObject({
    /** The most characters of submitted text sent to the model; a longer submission is skipped, never truncated. */
    maxInputChars: z.int().positive().max(400_000),
    maxOutputTokens: z.int().positive().max(32_000),
    maxCostCents: z.int().positive().max(10_000),
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
 * - `maxCostCents`: the most the run may spend across all its checks.
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
  maxCostCents: z.int().nonnegative().max(10_000),
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

/**
 * Whether an activity allows AI feedback on its work:
 * - `none`: no AI looks at the work; AI runs are skipped.
 * - `teacher-only`: AI feedback is advice to the teacher and is never released to the student.
 * - `releasable`: the teacher may release reviewed AI feedback to the student.
 *
 * It may belong with the activity definition in `@schoolos/contracts` once the curriculum service
 * (C05) owns activities.
 */
export const AiHelpPolicy = z.enum(["none", "teacher-only", "releasable"]);
/** An AI-help policy. */
export type AiHelpPolicy = z.infer<typeof AiHelpPolicy>;

/** Where an activity's AI-help policy comes from. An activity with none is treated as `none`. */
export interface AiHelpPolicySource {
  aiHelpPolicy(activityId: ActivityId): Promise<AiHelpPolicy | undefined>;
}
