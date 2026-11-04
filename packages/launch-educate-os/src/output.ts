// Everything the launcher prints goes through one Output, which redacts every secret it has been
// told about (the API token, gatekeeper and service secrets) from every line, human or JSON, as a
// second line of defence behind the installer's own rule that errors never quote them.
import { EducateOsError } from "@educateos/contracts";
import { InstallerHaltedError } from "@educateos/installer";

/** Where output goes. `process.stdout` and `process.stderr` satisfy it. */
export interface Writer {
  write(text: string): unknown;
}

/** A machine-readable progress event, one JSON object per line with `--json`. */
export type LaunchEvent =
  | { event: "release"; releaseId: string; version: string; channel: string; expiresAt: string; source: string }
  | { event: "preflight"; ok: boolean; blocking: Finding[]; warnings: Finding[] }
  | { event: "plan"; steps: { action: string; key: string; reason: string }[]; blocked: { action: string; key: string; reason: string }[]; cost: unknown[] }
  | { event: "step"; index: number; total: number; action: string; key: string }
  | { event: "done"; status: string; urls: Record<string, string>; nextSteps: string[] }
  | { event: "rollback"; fromReleaseId: string; toReleaseId: string; steps: { action: string; scriptName: string; reason: string }[]; irreversible: string[] }
  | { event: "doctor"; check: string; ok: boolean; detail: string }
  | { event: "error"; code: string; message: string };

/** A preflight finding. */
export interface Finding {
  code: string;
  message: string;
  operatorAction?: string;
}

/** The launcher's output: human lines, or JSON events with `--json`. */
export class Output {
  readonly json: boolean;
  readonly #out: Writer;
  readonly #err: Writer;
  readonly #secrets = new Set<string>();

  constructor(options: { json: boolean; out: Writer; err: Writer }) {
    this.json = options.json;
    this.#out = options.out;
    this.#err = options.err;
  }

  /** Redacts `value` from everything printed from now on. Short values are ignored. */
  secret(value: string | undefined): void {
    if (value !== undefined && value.length >= 6) this.#secrets.add(value);
  }

  /** `text` with every known secret replaced. */
  redact(text: string): string {
    let redacted = text;
    for (const secret of this.#secrets) redacted = redacted.replaceAll(secret, "[redacted]");
    return redacted;
  }

  /** A human line on stdout; with `--json`, on stderr, so stdout stays JSON. */
  line(text = ""): void {
    (this.json ? this.#err : this.#out).write(`${this.redact(text)}\n`);
  }

  /** A JSON event on stdout with `--json`; nothing otherwise. */
  event(event: LaunchEvent): void {
    if (this.json) this.#out.write(`${this.redact(JSON.stringify(event))}\n`);
  }

  /** An error, as a JSON event or a line on stderr. */
  error(error: unknown): void {
    const { code, message } = describeError(error);
    if (this.json) this.event({ event: "error", code, message });
    else this.#err.write(`${this.redact(`error (${code}): ${message}`)}\n`);
  }
}

/**
 * A safe description of a failure. EducateOS errors carry messages written never to quote a secret;
 * anything else is described by its name only, since a stray exception could quote the token.
 */
export function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof InstallerHaltedError || error instanceof EducateOsError) return { code: error.code, message: error.message };
  return { code: "unexpected", message: error instanceof Error ? `unexpected ${error.name}` : "unexpected error" };
}
