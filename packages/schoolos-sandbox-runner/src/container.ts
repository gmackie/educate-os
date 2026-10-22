// The container one job runs in, as the runner needs it. `cloudflareJobContainer` (in `worker.ts`)
// maps it onto a Durable Object's `ctx.container`; tests use a fake. Keeping the runner behind this
// port is what lets it be tested without a Cloudflare account.
import type { RunnerJobRequest } from "@schoolos/assessment-ai/cloudflare-sandbox";

/** How to start a job's container. Internet access is never on: only `allowHttpsHosts` are reachable. */
export interface ContainerStart {
  readonly instanceType: RunnerJobRequest["instanceType"];
  readonly runtime: RunnerJobRequest["runtime"];
  /** The hosts the job may reach over HTTPS. Empty for `egress: none`. */
  readonly allowHttpsHosts: readonly string[];
}

/** A running command: its output streams and how it exited. */
export interface ContainerProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** The exit code. Rejects if the process was aborted before it exited. */
  readonly exitCode: Promise<number>;
}

/** One job's container: a fresh, isolated machine that is destroyed when the job ends. */
export interface JobContainer {
  /** Boots the container. A failure here is transient: the job is retried. */
  start(options: ContainerStart): Promise<void>;
  /** Writes a file, creating its directories. */
  writeFile(path: string, text: string): Promise<void>;
  /** Runs a command; aborting `signal` kills it. */
  exec(command: readonly string[], options: { cwd: string; signal: AbortSignal }): Promise<ContainerProcess>;
  /** A file's text, or `undefined` if there is none. */
  readFile(path: string): Promise<string | undefined>;
  /** How many outbound requests to hosts outside the allowlist the container refused. */
  deniedEgress(): Promise<number>;
  /** Destroys the container and everything in it. */
  destroy(): Promise<void>;
}
