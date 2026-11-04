// Questions on a terminal. One reader over the input stream serves both plain lines and hidden
// input: on a real TTY a hidden answer is read in raw mode, so nothing typed is echoed; on any
// other stream (a pipe, or the tests' scripted terminal) lines are read as they come.
import { EducateOsError } from "@educateos/contracts";

/** Thrown when the operator presses Ctrl-C or the input ends mid-question. */
export class PromptCancelled extends EducateOsError {
  constructor() {
    super("validation-failed", "cancelled");
    this.name = "PromptCancelled";
  }
}

/** One choice of a {@link Prompter.select}. */
export interface Choice<T> {
  label: string;
  value: T;
}

/** What the wizard asks with. */
export interface Prompter {
  /** A line of text. Blank takes `default`; `validate` returns an error message to ask again. */
  text(question: string, options?: { default?: string; validate?: (value: string) => string | undefined }): Promise<string>;
  /** A line typed without echo. Never shown, logged or returned anywhere but to the caller. */
  secret(question: string): Promise<string>;
  /** Yes or no. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** One of a numbered list. */
  select<T>(question: string, choices: Choice<T>[], defaultIndex?: number): Promise<T>;
  /** Releases the input stream. */
  close(): void;
}

/** The streams a prompter reads and writes. `process.stdin` and `process.stdout` satisfy them. */
export interface PromptStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: { write(text: string): unknown };
}

/** A prompter over a terminal or any pair of streams. */
export function streamPrompter({ input, output }: PromptStreams): Prompter {
  let buffer = "";
  let ended = false;
  let waiting: (() => void) | undefined;
  const wake = () => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.();
  };
  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    wake();
  };
  const onEnd = () => {
    ended = true;
    wake();
  };
  input.on("data", onData);
  input.on("end", onEnd);
  input.resume?.();

  const nextChunk = () => new Promise<void>((resolve) => {
    waiting = resolve;
  });

  async function readLine(): Promise<string> {
    for (;;) {
      const newline = buffer.search(/\r?\n|\r/);
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));
        if (line.includes("\u0003")) throw new PromptCancelled();
        return line;
      }
      if (buffer.includes("\u0003")) throw new PromptCancelled();
      if (ended) throw new PromptCancelled();
      await nextChunk();
    }
  }

  // Raw mode: characters arrive one by one and the terminal echoes nothing.
  async function readHidden(): Promise<string> {
    if (!input.isTTY || typeof input.setRawMode !== "function") return await readLine();
    input.setRawMode(true);
    let value = "";
    try {
      for (;;) {
        while (buffer.length > 0) {
          const char = buffer[0]!;
          buffer = buffer.slice(1);
          if (char === "\u0003") throw new PromptCancelled();
          if (char === "\r" || char === "\n") return value;
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else if (char >= " ") value += char;
        }
        if (ended) throw new PromptCancelled();
        await nextChunk();
      }
    } finally {
      input.setRawMode(false);
      output.write("\n");
    }
  }

  const prompter: Prompter = {
    async text(question, options = {}) {
      for (;;) {
        output.write(`${question}${options.default ? ` [${options.default}]` : ""}: `);
        const answer = (await readLine()).trim() || options.default || "";
        const problem = options.validate?.(answer);
        if (problem === undefined) return answer;
        output.write(`  ${problem}\n`);
      }
    },
    async secret(question) {
      output.write(`${question} (input hidden): `);
      return (await readHidden()).trim();
    },
    async confirm(question, defaultYes) {
      for (;;) {
        output.write(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `);
        const answer = (await readLine()).trim().toLowerCase();
        if (answer === "") return defaultYes;
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
        output.write("  Answer y or n.\n");
      }
    },
    async select(question, choices, defaultIndex = 0) {
      output.write(`${question}\n`);
      choices.forEach((choice, i) => output.write(`  ${i + 1}) ${choice.label}\n`));
      const answer = await prompter.text("Choose a number", {
        default: String(defaultIndex + 1),
        validate: (value) => (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= choices.length ? undefined : `Enter 1 to ${choices.length}.`),
      });
      return choices[Number(answer) - 1]!.value;
    },
    close() {
      input.off("data", onData);
      input.off("end", onEnd);
      input.pause?.();
    },
  };
  return prompter;
}
