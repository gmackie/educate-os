import type { PrincipalId } from "@schoolos/contracts";

/** What one fake completion cost. Token counts are whitespace-separated words. */
export interface FakeUsage {
  /** Words in the prompt. */
  inputTokens: number;
  /** Words in the response. */
  outputTokens: number;
}

/** Per-principal usage. It holds counts only, never prompt or response text (roadmap §8). */
export interface UsageTotals {
  /** Completions made. */
  requests: number;
  /** Input plus output tokens. */
  tokens: number;
}

const countTokens = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * A deterministic stand-in for a model provider. It echoes a summary of the prompt so tests can
 * assert on output, and keeps a usage ledger the way G01's real ledger will: attributed to a
 * principal, with no content retained.
 */
export class FakeAiProvider {
  readonly #usage = new Map<PrincipalId, UsageTotals>();

  /** Completes `prompt` for `principalId` and records the usage. */
  complete(principalId: PrincipalId, prompt: string): { text: string; usage: FakeUsage } {
    const inputTokens = countTokens(prompt);
    const text = `[fake-model] received ${inputTokens} words.`;
    const usage = { inputTokens, outputTokens: countTokens(text) };
    const totals = this.#usage.get(principalId) ?? { requests: 0, tokens: 0 };
    this.#usage.set(principalId, {
      requests: totals.requests + 1,
      tokens: totals.tokens + usage.inputTokens + usage.outputTokens,
    });
    return { text, usage };
  }

  /** Usage for one principal. */
  usageFor(principalId: PrincipalId): UsageTotals {
    return this.#usage.get(principalId) ?? { requests: 0, tokens: 0 };
  }

  /** Usage summed over every principal. */
  totals(): UsageTotals {
    let requests = 0;
    let tokens = 0;
    for (const totals of this.#usage.values()) {
      requests += totals.requests;
      tokens += totals.tokens;
    }
    return { requests, tokens };
  }
}
