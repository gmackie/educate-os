// Runs one job the way `createCloudflareSandbox` asked: in a fresh container, killed at its
// wall-clock bound or once its output passes the cap, with the egress rule applied, and destroyed
// afterwards whatever happened. It reports what it observed and nothing else: wall-clock time, the
// exit code, output size and the harness's test results. The adapter derives CPU time and cost.
import { z } from "zod";
import type { RunnerJobRequest, RunnerJobResponse } from "@schoolos/assessment-ai/cloudflare-sandbox";
import type { JobContainer } from "./container.ts";

/** Where the job's files are written, and its working directory. */
export const WORK_DIR = "/work";

/** Where the image's test harness writes its report. Outside {@link WORK_DIR}, so no submitted file can be it. */
export const REPORT_PATH = "/var/schoolos/report.json";

/**
 * The command each runtime's image runs an entrypoint with: the image's harness, which runs the
 * entrypoint's tests and writes `{ tests: [{ name, passed }] }` to {@link REPORT_PATH} (spike step 1).
 */
export const RUNTIME_COMMANDS: Readonly<Record<RunnerJobRequest["runtime"], (entrypoint: string) => string[]>> = {
  "python-3": (entrypoint) => ["/opt/schoolos/harness", "python3", entrypoint],
  "node-22": (entrypoint) => ["/opt/schoolos/harness", "node", entrypoint],
};

/**
 * The exit code of a process the kernel killed with SIGKILL, which is how a container's
 * out-of-memory kill shows. Nothing else in the harness sends SIGKILL, so the runner reads it as the
 * memory limit; the spike's step 7 checks that reading.
 */
export const OOM_KILL_EXIT_CODE = 137;

/** A request the runner refuses outright, which the Worker answers with 400. */
export class RunnerRequestError extends Error {
  override readonly name = "RunnerRequestError";
}

const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$/;

/** Whether `path` is a plain relative path: no leading `/`, no `.` or `..` segments, nothing unusual. */
export function isSafeRelativePath(path: string): boolean {
  return SAFE_PATH.test(path) && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const HarnessReport = z.object({
  tests: z.array(z.object({ name: z.string().min(1), passed: z.boolean() })).max(1000),
});

/** The harness's results, names cut to what the response allows; none if it wrote no readable report. */
function testsFrom(report: string | undefined): { name: string; passed: boolean }[] {
  if (report === undefined) return [];
  let json: unknown;
  try {
    json = JSON.parse(report);
  } catch {
    return [];
  }
  const parsed = HarnessReport.safeParse(json);
  return parsed.success ? parsed.data.tests.map((t) => ({ name: t.name.slice(0, 200), passed: t.passed })) : [];
}

/** What {@link runJob} needs besides the job and its container. */
export interface RunJobOptions {
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Runs `job` in `container`, which is destroyed before this returns or throws. A container that
 * cannot start throws, so the adapter retries the job; everything after that is an answer.
 *
 * @throws RunnerRequestError for an entrypoint or file path that is not a plain relative path.
 */
export async function runJob(job: RunnerJobRequest, container: JobContainer, options: RunJobOptions = {}): Promise<RunnerJobResponse> {
  const now = options.now ?? Date.now;
  if (!isSafeRelativePath(job.entrypoint) || !job.files.every((file) => isSafeRelativePath(file.path))) {
    throw new RunnerRequestError("A job's entrypoint and files must be plain relative paths.");
  }
  try {
    await container.start({
      instanceType: job.instanceType,
      runtime: job.runtime,
      allowHttpsHosts: job.egress.kind === "allowlist" ? job.egress.hosts : [],
    });
    for (const file of job.files) await container.writeFile(`${WORK_DIR}/${file.path}`, file.text);

    const controller = new AbortController();
    let stopped: "wall-clock" | "output" | undefined;
    const stop = (reason: "wall-clock" | "output") => {
      stopped ??= reason;
      controller.abort();
    };
    const started = now();
    const timer = setTimeout(() => stop("wall-clock"), job.wallClockMs);
    let outputBytes = 0;
    let exitCode: number | undefined;
    try {
      const child = await container.exec(RUNTIME_COMMANDS[job.runtime](job.entrypoint), { cwd: WORK_DIR, signal: controller.signal });
      // Output is counted as it streams and never kept: the job is stopped as soon as it passes the cap.
      const drain = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            outputBytes += value.byteLength;
            if (outputBytes > job.maxOutputBytes) {
              stop("output");
              return;
            }
          }
        } catch {
          // The stream ends abruptly when the job is killed; what was counted stands.
        } finally {
          await reader.cancel().catch(() => {});
        }
      };
      const [code] = await Promise.all([child.exitCode.catch(() => undefined), drain(child.stdout), drain(child.stderr)]);
      exitCode = code;
    } finally {
      clearTimeout(timer);
    }
    const wallMs = Math.max(0, Math.round(now() - started));

    if (stopped !== undefined) return { status: "limit-exceeded", limit: stopped, wallMs };
    if ((await container.deniedEgress()) > 0) return { status: "limit-exceeded", limit: "network", wallMs };
    if (exitCode === OOM_KILL_EXIT_CODE) return { status: "limit-exceeded", limit: "memory", wallMs };
    // A process that vanished without an exit code was killed by something other than the runner.
    if (exitCode === undefined) return { status: "limit-exceeded", limit: "memory", wallMs };
    return { status: "completed", exitCode, tests: testsFrom(await container.readFile(REPORT_PATH)), outputBytes, wallMs };
  } finally {
    await container.destroy().catch(() => {});
  }
}
