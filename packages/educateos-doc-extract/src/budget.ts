import type { NotExtractableReason } from "@educateos/content-studio";

/**
 * Stops extraction with a reason. Thrown deep inside a parser and caught once, at the entry point,
 * where it becomes a `not-extractable` result.
 */
export class ExtractionStopped extends Error {
  /** Why extraction stopped. */
  readonly reason: NotExtractableReason;

  constructor(reason: NotExtractableReason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * A count of work units an extraction may spend. Every loop over untrusted input spends from it, so
 * the work one document can cost is bounded whatever its shape. A wall-clock deadline would not
 * do: Workers do not advance the clock during synchronous work, so only counting bounds CPU.
 */
export class StepBudget {
  #remaining: number;

  constructor(steps: number) {
    this.#remaining = steps;
  }

  /**
   * Spends `steps` units.
   *
   * @throws ExtractionStopped `budget-exceeded` once the budget is spent.
   */
  spend(steps = 1): void {
    this.#remaining -= steps;
    if (this.#remaining < 0) throw new ExtractionStopped("budget-exceeded");
  }
}

/** Collects extracted text up to a cap, and records whether anything was cut. */
export class TextSink {
  readonly #max: number;
  readonly #parts: string[] = [];
  #length = 0;
  /** Whether text was offered after the cap was reached. */
  truncated = false;

  constructor(maxChars: number) {
    this.#max = maxChars;
  }

  /** Whether the cap has been reached, so callers can stop early. */
  get full(): boolean {
    return this.#length >= this.#max;
  }

  /** Appends `text`, cutting it at the cap. */
  write(text: string): void {
    if (text === "") return;
    const room = this.#max - this.#length;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = text.length > room ? text.slice(0, room) : text;
    if (kept.length < text.length) this.truncated = true;
    this.#parts.push(kept);
    this.#length += kept.length;
  }

  /** Ends the current line, unless the text already ends one. */
  newline(): void {
    const last = this.#parts.at(-1);
    if (last !== undefined && !last.endsWith("\n")) this.write("\n");
  }

  /** The text collected, with runs of blank lines and trailing spaces collapsed. */
  text(): string {
    return this.#parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
}
