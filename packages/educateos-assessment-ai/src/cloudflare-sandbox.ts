// An `ExecutionSandbox` backed by Cloudflare Containers (SCHO-102 spike skeleton). It is OFF unless
// the district turns on `EDUCATEOS_ASSESSMENT_SANDBOX_CLOUDFLARE`, and nothing about it has run
// against a real account yet: `docs/educateos/spikes/assessment-sandbox-cloudflare.md` is the plan
// that verifies it.
//
// The adapter does not start containers itself. It speaks a small JSON protocol to a runner Worker
// in the district's own account (reached through a service binding), which owns one Durable Object
// per job and drives `ctx.container` (Sandbox SDK 1.0). What the adapter decides, the runner only
// carries out: the instance type from `memoryMb`, a wall-clock bound that is a sound upper bound on
// CPU time, a bound that keeps the job inside the run's remaining cost, and the egress rule. The
// runner's answer is untrusted and parsed strictly; every limit is re-checked here.
import { z } from "zod";
import { compareUsdNano, EducateOsError, usdNano, type UsdNano } from "@educateos/contracts";
import type { CiSandboxProfile } from "./profiles.ts";
import { type ExecutionSandbox, type SandboxAvailability, type SandboxJob, type SandboxResult, unavailableSandbox } from "./sandbox.ts";

/** The feature flag. Only the exact value `on` enables the Cloudflare backend. */
export const CLOUDFLARE_SANDBOX_FLAG = "EDUCATEOS_ASSESSMENT_SANDBOX_CLOUDFLARE";

/** Why the backend refuses while the flag is off. */
export const CLOUDFLARE_SANDBOX_DISABLED_REASON = "The Cloudflare execution sandbox is turned off for this district.";

/** Whether the flag is on in an environment. Anything other than `on` is off. */
export function cloudflareSandboxEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[CLOUDFLARE_SANDBOX_FLAG] === "on";
}

/**
 * A Containers instance type, with its vCPU share and memory. From
 * https://developers.cloudflare.com/containers/platform-details/limits/ (2026-10-21); to be
 * re-checked by the spike.
 */
export interface ContainerInstanceType {
  readonly name: "lite" | "basic" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
  readonly vcpu: number;
  readonly memoryMib: number;
}

/** The instance types, smallest first. */
export const CONTAINER_INSTANCE_TYPES: readonly ContainerInstanceType[] = [
  { name: "lite", vcpu: 1 / 16, memoryMib: 256 },
  { name: "basic", vcpu: 1 / 4, memoryMib: 1024 },
  { name: "standard-1", vcpu: 1 / 2, memoryMib: 4096 },
  { name: "standard-2", vcpu: 1, memoryMib: 6144 },
  { name: "standard-3", vcpu: 2, memoryMib: 8192 },
  { name: "standard-4", vcpu: 4, memoryMib: 12288 },
];

/**
 * Containers list prices in nanodollars (ADR-0008), from
 * https://developers.cloudflare.com/containers/pricing/ (2026-10-21): $0.000020 per vCPU-second and
 * $0.0000025 per GiB-second. Disk and egress are left out; the spike measures whether they matter
 * for a test run.
 */
export interface ContainerPricing {
  readonly usdNanoPerVcpuSecond: UsdNano;
  readonly usdNanoPerGibSecond: UsdNano;
}

/** List prices at the time of writing. A district passes its own if its contract differs. */
export const CONTAINER_LIST_PRICING: ContainerPricing = { usdNanoPerVcpuSecond: "20000", usdNanoPerGibSecond: "2500" };

/** The smallest instance type with at least `memoryMb` of memory, or undefined if none has. */
export function instanceTypeFor(memoryMb: number): ContainerInstanceType | undefined {
  return CONTAINER_INSTANCE_TYPES.find((type) => type.memoryMib >= memoryMb);
}

/** The most an instance of `type` can cost per wall-clock second, in nanodollars: active vCPU plus provisioned memory. */
export function usdNanoPerWallSecond(type: ContainerInstanceType, pricing: ContainerPricing): number {
  return type.vcpu * Number(pricing.usdNanoPerVcpuSecond) + (type.memoryMib / 1024) * Number(pricing.usdNanoPerGibSecond);
}

/** What the adapter sends the runner Worker for one job. */
export const RunnerJobRequest = z.strictObject({
  jobId: z.string().min(1).max(200),
  runtime: z.enum(["python-3", "node-22"]),
  instanceType: z.enum(["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"]),
  /** The runner kills the job at this wall-clock time. */
  wallClockMs: z.int().positive(),
  /** The runner stops reading output past this and kills the job. */
  maxOutputBytes: z.int().positive(),
  egress: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({ kind: z.literal("allowlist"), hosts: z.array(z.string().min(1)).min(1).max(20) }),
  ]),
  entrypoint: z.string().min(1),
  files: z.array(z.strictObject({ path: z.string().min(1), text: z.string() })),
});
/** A runner job request. */
export type RunnerJobRequest = z.infer<typeof RunnerJobRequest>;

/**
 * What the runner answers. It reports wall-clock time, never CPU time or cost, and carries no
 * free text the adapter would pass on: details are written here, from the limit it names.
 */
export const RunnerJobResponse = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    exitCode: z.int(),
    tests: z.array(z.strictObject({ name: z.string().min(1).max(200), passed: z.boolean() })).max(1000),
    outputBytes: z.int().nonnegative(),
    wallMs: z.int().nonnegative(),
  }),
  z.strictObject({
    status: z.literal("limit-exceeded"),
    limit: z.enum(["wall-clock", "memory", "output", "network"]),
    wallMs: z.int().nonnegative(),
  }),
  z.strictObject({ status: z.literal("unavailable") }),
]);
/** A runner job response. */
export type RunnerJobResponse = z.infer<typeof RunnerJobResponse>;

/** What {@link createCloudflareSandbox} needs. */
export interface CloudflareSandboxOptions {
  /** The feature flag's value, usually from {@link cloudflareSandboxEnabled}. */
  readonly enabled: boolean;
  /** The runner Worker's jobs URL, reached through `fetch` (a service binding's, in production). */
  readonly endpoint: string;
  readonly fetch: typeof fetch;
  /** Defaults to {@link CONTAINER_LIST_PRICING}. */
  readonly pricing?: ContainerPricing;
}

/**
 * The Cloudflare Containers execution sandbox, or {@link unavailableSandbox} while the flag is off.
 * A runner failure (no response, a 5xx, a malformed answer) throws, so the run retries the job
 * under the same job ID; the runner deduplicates on it.
 */
export function createCloudflareSandbox(options: CloudflareSandboxOptions): ExecutionSandbox {
  if (!options.enabled) return unavailableSandbox(CLOUDFLARE_SANDBOX_DISABLED_REASON);
  return new CloudflareContainerSandbox(options);
}

class CloudflareContainerSandbox implements ExecutionSandbox {
  readonly #options: CloudflareSandboxOptions;
  readonly #pricing: ContainerPricing;

  constructor(options: CloudflareSandboxOptions) {
    this.#options = options;
    this.#pricing = options.pricing ?? CONTAINER_LIST_PRICING;
  }

  availability(): SandboxAvailability {
    return { available: true };
  }

  async run(job: SandboxJob): Promise<SandboxResult> {
    const { profile } = job;
    const type = instanceTypeFor(profile.memoryMb);
    if (type === undefined) return { status: "unavailable", reason: `No container instance type has ${profile.memoryMb} MB of memory.` };
    const perSecond = usdNanoPerWallSecond(type, this.#pricing);
    const costLimit = compareUsdNano(profile.maxCostUsdNano, job.remainingCostUsdNano) <= 0 ? profile.maxCostUsdNano : job.remainingCostUsdNano;
    // Wall-clock time bounds CPU time from above (a job cannot use more than `vcpu` CPU-seconds per
    // second), so `cpuMs / vcpu` of wall clock is the most the CPU limit allows. The cost limit
    // allows `costLimit / perSecond` seconds. The job gets the smaller.
    const cpuBoundMs = Math.floor(profile.cpuMs / type.vcpu);
    const costBoundMs = Math.floor((Number(costLimit) / perSecond) * 1000);
    if (costBoundMs < 1) return limit("cost", profile, costLimit, 0, "0");
    const wallClockMs = Math.min(cpuBoundMs, costBoundMs);
    const request: RunnerJobRequest = {
      jobId: job.jobId,
      runtime: profile.runtime,
      instanceType: type.name,
      wallClockMs,
      maxOutputBytes: profile.maxOutputBytes,
      egress: profile.egress.kind === "none" ? { kind: "none" } : { kind: "allowlist", hosts: [...profile.egress.hosts] },
      entrypoint: job.entrypoint,
      files: job.files.map((f) => ({ path: f.path, text: f.text })),
    };

    const answer = await this.#post(request);
    if (answer.status === "unavailable") return { status: "unavailable", reason: "The Cloudflare execution sandbox could not take the job." };
    // Usage is derived from wall-clock time and capped at the limits, so a runner that reports
    // running past its bound cannot make the result claim more than the profile allows.
    const wallMs = Math.min(answer.wallMs, wallClockMs);
    const cpuMs = Math.min(Math.ceil(wallMs * type.vcpu), profile.cpuMs);
    const charged = usdNano(BigInt(Math.ceil((wallMs / 1000) * perSecond)));
    const costUsdNano = compareUsdNano(charged, costLimit) <= 0 ? charged : costLimit;
    const clockLimit = wallClockMs === costBoundMs ? "cost" : "cpu";
    // A runner that ran past the bound it was given is not trusted with its own result.
    if (answer.wallMs > wallClockMs) return limit(clockLimit, profile, costLimit, cpuMs, costUsdNano);
    if (answer.status === "limit-exceeded") {
      return limit(answer.limit === "wall-clock" ? clockLimit : answer.limit, profile, costLimit, cpuMs, costUsdNano);
    }
    if (answer.outputBytes > profile.maxOutputBytes) return limit("output", profile, costLimit, cpuMs, costUsdNano);
    return { status: "completed", exitCode: answer.exitCode, tests: answer.tests, outputBytes: answer.outputBytes, cpuMs, costUsdNano };
  }

  async #post(request: RunnerJobRequest): Promise<RunnerJobResponse> {
    let response: Response;
    try {
      response = await this.#options.fetch(this.#options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch {
      throw new EducateOsError("unavailable", "The sandbox runner did not answer.");
    }
    if (!response.ok) throw new EducateOsError("unavailable", `The sandbox runner answered HTTP ${response.status}.`);
    const parsed = RunnerJobResponse.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new EducateOsError("unavailable", "The sandbox runner's answer was malformed.");
    return parsed.data;
  }
}

function limit(reached: "cpu" | "cost" | "memory" | "output" | "network", profile: CiSandboxProfile, costLimit: UsdNano, cpuMs: number, costUsdNano: UsdNano): SandboxResult {
  const detail = {
    cpu: `The job used more than ${profile.cpuMs} ms of CPU time.`,
    cost: `The job would cost more than the ${costLimit} nanodollars the run has left.`,
    memory: `The job used more than ${profile.memoryMb} MB of memory.`,
    output: `The job wrote more than ${profile.maxOutputBytes} bytes of output.`,
    network: "The job tried to reach a host its profile does not allow.",
  }[reached];
  return { status: "limit-exceeded", limit: reached, detail, cpuMs, costUsdNano };
}
