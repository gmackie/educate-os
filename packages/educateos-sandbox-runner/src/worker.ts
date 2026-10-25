// The runner Worker: the far end of `createCloudflareSandbox`'s service binding. It has no route and
// no workers.dev address, so the district backend's service binding is the only way to reach it:
// that binding is its authentication. Each job is routed to a Durable Object named by its job ID,
// so a retry of the same job reaches the same object, which answers from what it already ran
// instead of running the job twice.
//
// Nothing here imports `cloudflare:workers`: the Durable Object is a plain class and the storage and
// container it uses are named structurally, so the package type-checks against the web-standard
// surface (ADR-0009) and its tests inject a fake container.
//
// Deploying it needs a Worker config this package deliberately does not have yet (a `containers`
// entry per runtime image, the `JOBS` namespace with `scheduling_policy: "durable_object"`, and no
// routes): writing that config is step 2 of the SCHO-102 spike, against a sandbox account.
import { RunnerJobRequest, type RunnerJobResponse } from "@educateos/assessment-ai/cloudflare-sandbox";
import type { ContainerProcess, ContainerStart, JobContainer } from "./container.ts";
import { RunnerRequestError, runJob } from "./runner.ts";

/** The path the adapter posts jobs to. */
export const JOBS_PATH = "/v1/jobs";

/** The largest job request accepted, in bytes: well above a profile's 2 MiB of submitted work. */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** The bindings the runner Worker needs. */
export interface RunnerEnv {
  /** The per-job Durable Objects ({@link SandboxJob}). */
  readonly JOBS: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
}

/** The part of a Durable Object's state a job object uses. `DurableObjectState` satisfies it. */
export interface JobObjectState {
  readonly storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
  };
  /** The object's container, on a Durable Object class configured with one. */
  readonly container?: unknown;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Reads and validates a job request body, or answers why not. */
async function readJob(request: Request): Promise<RunnerJobRequest | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_REQUEST_BYTES) return json({ error: "too-large" }, 413);
  const text = await request.text();
  if (text.length > MAX_REQUEST_BYTES) return json({ error: "too-large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "malformed" }, 400);
  }
  const parsed = RunnerJobRequest.safeParse(body);
  return parsed.success ? parsed.data : json({ error: "malformed" }, 400);
}

/** The runner Worker's fetch handler: `POST /v1/jobs` with a `RunnerJobRequest`, and nothing else. */
export const runnerWorker = {
  async fetch(request: Request, env: RunnerEnv): Promise<Response> {
    if (new URL(request.url).pathname !== JOBS_PATH) return json({ error: "not-found" }, 404);
    if (request.method !== "POST") return json({ error: "method-not-allowed" }, 405);
    const job = await readJob(request);
    if (job instanceof Response) return job;
    return env.JOBS.getByName(job.jobId).fetch(new Request("https://sandbox-job.internal/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    }));
  },
};

/** What a job object keeps once its job has run: the request it ran, by digest, and the answer. */
interface StoredAnswer {
  requestDigest: string;
  response: RunnerJobResponse;
}

const RESULT_KEY = "answer";

async function digestOf(job: RunnerJobRequest): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(job));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The Durable Object one job runs in, named by its job ID. It runs the job at most once while its
 * answer is kept: a retry that arrives while the job runs waits for the same answer, and one that
 * arrives later gets the stored answer. A request under the same job ID that differs from the one
 * that ran answers 409, since a job ID names exactly one job.
 *
 * If the object restarts mid-job, the container is gone and nothing was stored, so the next retry
 * runs the job afresh; the adapter's cost bound applies to each run.
 */
export class SandboxJob {
  /** The object's state, as the runtime passed it. */
  protected readonly state: JobObjectState;
  #running: { requestDigest: string; answer: Promise<RunnerJobResponse> } | undefined;

  constructor(state: JobObjectState, _env: unknown) {
    this.state = state;
  }

  /** The container a job runs in: the object's own. Tests override this with a fake. */
  protected container(): JobContainer {
    return cloudflareJobContainer(this.state.container);
  }

  async fetch(request: Request): Promise<Response> {
    const job = await readJob(request);
    if (job instanceof Response) return job;
    const requestDigest = await digestOf(job);
    const stored = (await this.state.storage.get(RESULT_KEY)) as StoredAnswer | undefined;
    if (stored !== undefined) return stored.requestDigest === requestDigest ? json(stored.response) : json({ error: "job-id-reused" }, 409);
    if (this.#running !== undefined && this.#running.requestDigest !== requestDigest) return json({ error: "job-id-reused" }, 409);
    this.#running ??= { requestDigest, answer: this.#run(job, requestDigest) };
    try {
      return json(await this.#running.answer);
    } catch (error) {
      if (error instanceof RunnerRequestError) return json({ error: "malformed" }, 400);
      // The container could not be started or reached: the adapter retries under the same job ID.
      return json({ error: "unavailable" }, 503);
    }
  }

  async #run(job: RunnerJobRequest, requestDigest: string): Promise<RunnerJobResponse> {
    try {
      const response = await runJob(job, this.container());
      await this.state.storage.put(RESULT_KEY, { requestDigest, response } satisfies StoredAnswer);
      return response;
    } finally {
      this.#running = undefined;
    }
  }
}

/**
 * The parts of a Durable Object's `ctx.container` (Sandbox SDK 1.0) the runner uses, as the docs
 * describe them (https://developers.cloudflare.com/containers/api/durable-object-container/). None
 * of this has run against a real account: spike steps 2-8 confirm each method and its shape.
 */
interface CloudflareContainer {
  start(options: { enableInternet: boolean; instance?: string; env?: Record<string, string> }): void | Promise<void>;
  exec(command: string[], options: { cwd?: string; signal?: AbortSignal }): Promise<ContainerProcess>;
  interceptOutboundHttps(host: string, handler: (request: Request) => Promise<Response>): void | Promise<void>;
  interceptAllOutboundHttp(handler: (request: Request) => Promise<Response>): void | Promise<void>;
  destroy(): Promise<void>;
}

/** The image helper that appends base64 data to a file (spike step 1), since 1.0 has no file API. */
const PUT_FILE = "/opt/educateos/append-file";
/** Base64 written per `exec`, well under any argument-length limit. */
const WRITE_CHUNK_CHARS = 64 * 1024;

function isCloudflareContainer(value: unknown): value is CloudflareContainer {
  return typeof value === "object" && value !== null && ["start", "exec", "interceptOutboundHttps", "interceptAllOutboundHttp", "destroy"]
    .every((method) => typeof (value as Record<string, unknown>)[method] === "function");
}

async function exited(container: CloudflareContainer, command: string[]): Promise<{ code: number; stdout: string }> {
  const child = await container.exec(command, {});
  const [code, stdout] = await Promise.all([child.exitCode, new Response(child.stdout).text(), new Response(child.stderr).arrayBuffer()]);
  return { code, stdout };
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * {@link JobContainer} over a Durable Object's `ctx.container`. Internet access is always off; each
 * allowlisted host is passed through by an HTTPS intercept, and any other plain-HTTP request is
 * refused and counted. Unverified (see {@link CloudflareContainer}).
 */
export function cloudflareJobContainer(raw: unknown): JobContainer {
  if (!isCloudflareContainer(raw)) throw new Error("This Durable Object has no container; its class must be configured with one.");
  const container = raw;
  let denied = 0;
  return {
    async start(options: ContainerStart) {
      await container.start({ enableInternet: false, instance: options.instanceType });
      for (const host of options.allowHttpsHosts) await container.interceptOutboundHttps(host, (request) => fetch(request));
      await container.interceptAllOutboundHttp(async () => {
        denied += 1;
        return new Response(null, { status: 403 });
      });
    },
    async writeFile(path, text) {
      const encoded = base64(text);
      for (let at = 0; at === 0 || at < encoded.length; at += WRITE_CHUNK_CHARS) {
        const { code } = await exited(container, [PUT_FILE, path, encoded.slice(at, at + WRITE_CHUNK_CHARS)]);
        if (code !== 0) throw new Error(`writing ${path} failed`);
      }
    },
    exec: (command, options) => container.exec([...command], options),
    async readFile(path) {
      const { code, stdout } = await exited(container, ["cat", path]);
      return code === 0 ? stdout : undefined;
    },
    deniedEgress: async () => denied,
    destroy: () => container.destroy(),
  };
}
