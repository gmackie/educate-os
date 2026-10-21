// The execution sandbox port for executable checks (code tests and simulators). No real backend
// ships here: the default is `unavailable`, and `docs/schoolos/assessment-sandbox.md` records how a
// Cloudflare backend would map `CiSandboxProfile`, every capability of it unverified.
import { z } from "zod";
import { CriterionId } from "@schoolos/assessment";
import { CheckVisibility, type CriterionEvidence, type EvaluationArtifact } from "@schoolos/assessment-ci";
import { compareUsdNano, USD_NANO_PER_CENT, UsdNano, usdNanoFromRational, usdNanoValue } from "@schoolos/contracts";
import type { CiSandboxProfile } from "./profiles.ts";

/** Whether a sandbox can run jobs at all, and if not, why. */
export type SandboxAvailability = { available: true } | { available: false; reason: string };

/** A sandbox limit a job ran into. */
export const SandboxLimit = z.enum(["cpu", "memory", "output", "network", "cost"]);
/** A sandbox limit. */
export type SandboxLimit = z.infer<typeof SandboxLimit>;

/** An entrypoint a check names: a relative path of letters, digits, `.`, `_`, `-` and `/`. */
export const SandboxEntrypoint = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$/, "expected a relative path").refine((p) => !p.split("/").includes(".."), "no parent segments");

/** One job: the files it gets, what it runs, and what it may spend. */
export interface SandboxJob {
  /** `<runId>:<checkId>`: stable across retries, so a backend can deduplicate. */
  readonly jobId: string;
  readonly entrypoint: string;
  /** The submitted text, one file per artifact, named by artifact ID. */
  readonly files: readonly { path: string; text: string }[];
  readonly profile: CiSandboxProfile;
  /** What is left of the run's cost limit, in nanodollars; the job stops before it spends more. */
  readonly remainingCostUsdNano: UsdNano;
}

/** What a sandbox reports for a job. It is untrusted until parsed. */
export const SandboxResult = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    exitCode: z.int(),
    tests: z.array(z.strictObject({ name: z.string().min(1).max(200), passed: z.boolean() })).max(1000),
    outputBytes: z.int().nonnegative(),
    cpuMs: z.int().nonnegative(),
    costUsdNano: UsdNano,
  }),
  z.strictObject({
    status: z.literal("limit-exceeded"),
    limit: SandboxLimit,
    detail: z.string().min(1).max(500),
    cpuMs: z.int().nonnegative(),
    costUsdNano: UsdNano,
  }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.string().min(1).max(500) }),
]);
/** A sandbox result. */
export type SandboxResult = z.infer<typeof SandboxResult>;

/**
 * Runs executable checks in isolation. A backend enforces every limit of the job's profile
 * itself (CPU time, memory, output size, egress and cost), and the code it runs cannot change them.
 */
export interface ExecutionSandbox {
  availability(): SandboxAvailability;
  /** A transient failure throws, and the run retries the job under the same job ID. */
  run(job: SandboxJob): Promise<SandboxResult>;
}

/** Why the default sandbox refuses. */
export const SANDBOX_UNAVAILABLE_REASON = "No execution sandbox is configured for this district; executable checks need the optional CI sandbox.";

/** The default sandbox: it runs nothing and says why. */
export function unavailableSandbox(reason: string = SANDBOX_UNAVAILABLE_REASON): ExecutionSandbox {
  return {
    availability: () => ({ available: false, reason }),
    run: async () => ({ status: "unavailable", reason }),
  };
}

/** What a fake program may do: everything is metered, and the network is behind the allowlist. */
export interface FakeSandboxContext {
  readonly files: readonly { path: string; text: string }[];
  /** Spends CPU time. */
  cpu(ms: number): void;
  /** Takes memory; `free` gives it back. */
  allocate(mb: number): void;
  free(mb: number): void;
  /** Writes to the job's output. */
  write(text: string): void;
  /** Connects to `host`. Refused unless the profile's allowlist names it. */
  connect(host: string): void;
  /** Records one test result. */
  test(name: string, passed: boolean): void;
}

/** A program the fake sandbox runs in place of real code. It returns the exit code. */
export type FakeProgram = (context: FakeSandboxContext) => number | void;

class LimitHit extends Error {
  readonly limit: SandboxLimit;

  constructor(limit: SandboxLimit, detail: string) {
    super(detail);
    this.limit = limit;
  }
}

/**
 * A sandbox for tests, which runs {@link FakeProgram}s by entrypoint and enforces a profile's limits
 * as a real backend must: CPU time, peak memory, output size, egress (none, or only allowlisted
 * hosts) and the run's remaining cost, charged per CPU second and rounded up to the nanodollar.
 */
export class FakeExecutionSandbox implements ExecutionSandbox {
  readonly #programs: ReadonlyMap<string, FakeProgram>;
  readonly #usdNanoPerCpuSecond: bigint;
  /** Every job it was asked to run, in order. */
  readonly jobs: SandboxJob[] = [];

  /** `usdNanoPerCpuSecond` is the price of a CPU second; it defaults to one cent. */
  constructor(programs: Readonly<Record<string, FakeProgram>>, options: { usdNanoPerCpuSecond?: UsdNano } = {}) {
    this.#programs = new Map(Object.entries(programs));
    this.#usdNanoPerCpuSecond = usdNanoValue(options.usdNanoPerCpuSecond ?? USD_NANO_PER_CENT.toString());
  }

  availability(): SandboxAvailability {
    return { available: true };
  }

  async run(job: SandboxJob): Promise<SandboxResult> {
    this.jobs.push(job);
    const program = this.#programs.get(job.entrypoint);
    const { profile } = job;
    const costLimit = compareUsdNano(profile.maxCostUsdNano, job.remainingCostUsdNano) <= 0 ? profile.maxCostUsdNano : job.remainingCostUsdNano;
    let cpuMs = 0;
    let memory = 0;
    let outputBytes = 0;
    const tests: { name: string; passed: boolean }[] = [];
    const cost = () => usdNanoFromRational(BigInt(cpuMs) * this.#usdNanoPerCpuSecond, 1000n);
    const overLimit = () => compareUsdNano(cost(), costLimit) > 0;
    const context: FakeSandboxContext = {
      files: job.files,
      cpu: (ms) => {
        cpuMs += ms;
        if (cpuMs > profile.cpuMs) throw new LimitHit("cpu", `The job used more than ${profile.cpuMs} ms of CPU time.`);
        if (overLimit()) throw new LimitHit("cost", `The job would cost more than the ${costLimit} nanodollars the run has left.`);
      },
      allocate: (mb) => {
        memory += mb;
        if (memory > profile.memoryMb) throw new LimitHit("memory", `The job used more than ${profile.memoryMb} MB of memory.`);
      },
      free: (mb) => {
        memory = Math.max(0, memory - mb);
      },
      write: (text) => {
        outputBytes += new TextEncoder().encode(text).byteLength;
        if (outputBytes > profile.maxOutputBytes) throw new LimitHit("output", `The job wrote more than ${profile.maxOutputBytes} bytes of output.`);
      },
      connect: (host) => {
        const allowed = profile.egress.kind === "allowlist" && profile.egress.hosts.includes(host.toLowerCase());
        if (!allowed) throw new LimitHit("network", `The job tried to reach ${host.slice(0, 200)}, which its profile does not allow.`);
      },
      test: (name, passed) => {
        tests.push({ name, passed });
      },
    };
    if (program === undefined) return { status: "completed", exitCode: 127, tests: [], outputBytes: 0, cpuMs: 0, costUsdNano: "0" };
    try {
      const exitCode = program(context) ?? 0;
      return { status: "completed", exitCode, tests, outputBytes, cpuMs, costUsdNano: cost() };
    } catch (error) {
      if (error instanceof LimitHit) return { status: "limit-exceeded", limit: error.limit, detail: error.message, cpuMs: Math.min(cpuMs, profile.cpuMs), costUsdNano: overLimit() ? costLimit : cost() };
      // A crash inside the program is the program's failure, like a non-zero exit.
      return { status: "completed", exitCode: 1, tests, outputBytes, cpuMs, costUsdNano: cost() };
    }
  }
}

/** One executable check a teacher configures: which criterion it is evidence for, what it runs, and who sees it. */
export const SandboxCheck = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  criterionId: CriterionId,
  entrypoint: SandboxEntrypoint,
  visibility: CheckVisibility,
});
/** A sandbox check. */
export type SandboxCheck = z.infer<typeof SandboxCheck>;

/** The release every sandboxed check's evidence is labelled with. */
export const SANDBOX_EVALUATOR = Object.freeze({ id: "sandbox.tests", release: "1.0.0" });

/** The files a job gets: each submitted text artifact, named by its artifact ID. */
export function sandboxFiles(artifacts: readonly EvaluationArtifact[]): { path: string; text: string }[] {
  return artifacts.map((a) => ({ path: a.artifactId, text: a.text }));
}

/** The evidence a sandbox result gives a check's criterion. Program output is never copied into it. */
export function sandboxEvidence(check: SandboxCheck, result: Exclude<SandboxResult, { status: "unavailable" }>): CriterionEvidence {
  if (result.status === "limit-exceeded") {
    return { criterionId: check.criterionId, observation: `Stopped at the ${result.limit} limit`, passed: false, excerpts: [], explanation: result.detail };
  }
  const passed = result.tests.filter((t) => t.passed).length;
  const total = result.tests.length;
  return {
    criterionId: check.criterionId,
    observation: total === 0 ? `Exited with code ${result.exitCode}` : `${passed} of ${total} tests passed`,
    passed: result.exitCode === 0 && passed === total,
    ...(total === 0 ? {} : { score: passed / total }),
    excerpts: [],
    explanation: `${check.entrypoint} ran in the sandbox and exited with code ${result.exitCode}${total === 0 ? "" : `; failing tests: ${result.tests.filter((t) => !t.passed).map((t) => t.name).join(", ") || "none"}`}.`.slice(0, 2000),
  };
}
