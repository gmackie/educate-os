// A container for tests: it runs a scripted program in place of the image's harness, with output
// streamed in chunks, a clock the program advances, and the egress rule enforced as the runner set it.
import type { ContainerProcess, ContainerStart, JobContainer } from "../src/index.ts";
import { REPORT_PATH } from "../src/index.ts";

/** What a scripted program can do inside the fake container. */
export interface FakeProgramContext {
  /** The container's files, which the program may change. */
  readonly files: Map<string, string>;
  /** Writes output, which the runner reads as it streams. */
  write(text: string): Promise<void>;
  /** Lets `ms` of wall-clock time pass, as a busy program would. */
  spend(ms: number): Promise<void>;
  /** Tries an HTTPS request to `host`. */
  connect(host: string): boolean;
  /** Writes the harness report. */
  report(tests: { name: string; passed: boolean }[]): void;
}

/** A program: resolves to its exit code. */
export type FakeProgram = (context: FakeProgramContext) => Promise<number>;

/** A fake {@link JobContainer} and a clock its program drives. */
export class FakeJobContainer implements JobContainer {
  readonly #program: FakeProgram;
  readonly files = new Map<string, string>();
  started: ContainerStart | undefined;
  commands: (readonly string[])[] = [];
  destroyed = false;
  denied = 0;
  /** The fake clock, in milliseconds. */
  clock = 0;
  /** Make `start` fail, as a container that cannot be scheduled would. */
  failStart = false;

  constructor(program: FakeProgram) {
    this.#program = program;
  }

  now = (): number => this.clock;

  async start(options: ContainerStart): Promise<void> {
    if (this.failStart) throw new Error("no capacity");
    this.started = options;
  }

  async writeFile(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }

  async exec(command: readonly string[], options: { cwd: string; signal: AbortSignal }): Promise<ContainerProcess> {
    this.commands.push(command);
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    const aborted = new Promise<never>((_, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("killed")), { once: true });
    });
    const context: FakeProgramContext = {
      files: this.files,
      write: async (text) => {
        if (options.signal.aborted) throw new Error("killed");
        controller.enqueue(encoder.encode(text));
        // Let the runner read what was written before the program goes on.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      spend: async (ms) => {
        this.clock += ms;
        // A program that runs past its bound is still running when the runner's timer fires.
        await new Promise((resolve) => setTimeout(resolve, ms > 0 ? 5 : 0));
      },
      connect: (host) => {
        const allowed = this.started?.allowHttpsHosts.includes(host) ?? false;
        if (!allowed) this.denied += 1;
        return allowed;
      },
      report: (tests) => {
        this.files.set(REPORT_PATH, JSON.stringify({ tests }));
      },
    };
    const exitCode = Promise.race([this.#program(context), aborted]).finally(() => {
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    });
    return { stdout, stderr, exitCode };
  }

  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async deniedEgress(): Promise<number> {
    return this.denied;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}
