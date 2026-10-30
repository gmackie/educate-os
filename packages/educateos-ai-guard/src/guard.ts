// What the guard decides around one model call (ADR-0007): reserve generative funds, moderate the
// call's new messages with Hall Monitor out of the protected safety pool, apply Hall Monitor's
// decision, screen the model's response before release when the profile requires it, and settle
// the call's spend once it has ended.
//
// Privacy: message and response text goes to Hall Monitor and nowhere else. It is never logged or stored; logs
// carry identifiers, decisions and machine reason codes only.

import type {
  AiCallDecision,
  AiCallDescriptor,
  AiCallMessagePart,
  AiCallModelOutput,
  AiCallOutcome,
  AiCallOutputDecision,
} from "@gadgets/workshop-shared/ai-call-guard";
import { createLogger, type Logger } from "@gadgets/observability/logger";
import { HallMonitorError } from "@gmacko/hall-monitor-client";
import {
  MAX_TEXT_LENGTH,
  SCHEMA_VERSION,
  type CostReceipt,
  type Decision,
  type EvaluationKind,
  type EvaluationRequest,
  type EvaluationResult,
} from "@gmacko/hall-monitor-contracts";
import { denialErrorCode, type AiDenialReason, type ModelRef } from "@educateos/ai-governance";
import { guardMessages, type GuardConfig, type GuardMessages } from "./config.ts";
import type { GuardContext, GuardContextResolver } from "./context.ts";
import { receiptAttempts, type GuardHallMonitorClient } from "./hall-monitor.ts";
import { sourceEligibility } from "./source-governance.ts";
import type { DistrictAiLedger } from "./ledger-object.ts";
import type { GatewayLogSource } from "./gateway-logs.ts";
import { estimateMaxUsdNano, priceSettlement, rateFor, tokenUsageOf } from "./pricing.ts";

type GuardLogFields = {
  callId: string;
  callSite: string;
  checkId: string;
  audience: string;
  decision: string;
  reason: string;
  reasonCodes: string[];
  evaluationId: string;
  hallMonitorCode: string;
  hallMonitorStatus: number;
  status: string;
  outcome: string;
  degraded: string;
  gatewayLookup: string;
};

const logger = createLogger<GuardLogFields>({ component: "educateos.ai-guard" });

/** What the guard needs to decide: its configuration, the district ledger, and its two ports. */
export interface GuardDependencies {
  /** The deployment's configuration. */
  config: GuardConfig;
  /** The district ledger. */
  ledger: DurableObjectStub<DistrictAiLedger>;
  /** Maps a call's initiator to a principal and their moderation profile. */
  resolver: GuardContextResolver;
  /** Hall Monitor, or `null` when none is configured (moderation is then unavailable). */
  hallMonitor: GuardHallMonitorClient | null;
  /** The AI Gateway's logs, when the deployment can read them; settlements then use their costs. */
  gatewayLogs?: GatewayLogSource | null;
}

/** Hall Monitor decisions the guard stops a call for, most protective first. */
const STOPPING: readonly Decision[] = ["support", "block", "hold"];

const deny = (reason: string, message: string): AiCallDecision => ({ action: "deny", reason, message });
const withhold = (reason: string, message: string): AiCallOutputDecision => ({ action: "withhold", reason, message });
const RELEASE: AiCallOutputDecision = { action: "release" };

/** The text Hall Monitor evaluates for one message or response, in chunks it accepts. Attachments are skipped. */
function textChunks(parts: AiCallMessagePart[]): string[] {
  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_TEXT_LENGTH, text.length);
    // Never split a surrogate pair across two evaluations.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    if (text.slice(start, end).trim().length > 0) chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function machineReason(prefix: string, reason: AiDenialReason): string {
  return `${prefix}_${reason.replaceAll("-", "_")}`;
}

/** The price book shared by every attempt of a receipt, if they share one. */
function receiptPriceBook(receipt: CostReceipt): { priceBookId?: string } {
  const books = new Set(receipt.attempts.map((attempt) => attempt.priceBookId));
  const [book] = books;
  return books.size === 1 && book !== undefined ? { priceBookId: book } : {};
}

/** The verdict of moderating a call's new input or its response. */
type Moderation =
  /** It may proceed; `coach` when the model should coach rather than answer. */
  | { kind: "proceed"; coach: boolean }
  | { kind: "deny"; reason: string; message: string };

/**
 * The guard's decisions, independent of how it is reached. `EducateOsAiCallGuard` builds one per
 * call from its environment; tests build one directly.
 */
export class AiCallGuardService {
  readonly #config: GuardConfig;
  readonly #ledger: DurableObjectStub<DistrictAiLedger>;
  readonly #resolver: GuardContextResolver;
  readonly #hallMonitor: GuardHallMonitorClient | null;
  readonly #gatewayLogs: GatewayLogSource | null;
  readonly #messages: GuardMessages;

  constructor(dependencies: GuardDependencies) {
    this.#config = dependencies.config;
    this.#ledger = dependencies.ledger;
    this.#resolver = dependencies.resolver;
    this.#hallMonitor = dependencies.hallMonitor;
    this.#gatewayLogs = dependencies.gatewayLogs ?? null;
    this.#messages = guardMessages(dependencies.config);
  }

  /**
   * Admits or refuses one model call. It holds the call's maximum cost from the principal's
   * generative funding (keyed by `callId`), then has Hall Monitor evaluate each new message's text,
   * each evaluation held from and settled to the safety pool. A refused call has its generative
   * hold released; moderation spend is kept, since it was spent.
   *
   * - `allow` and `coach` proceed. A `coach`, or under a `contextual` or `scaffolded` profile an
   *   `academic_integrity.*` reason code, adds the configured coaching instructions to a
   *   language-model call, for that request only.
   * - `hold` and `block` deny with a neutral message; `support` denies with a supportive one that
   *   points to a person, never a reprimand.
   * - A safety pool too low to fund a check denies the call: moderation is never skipped to save
   *   money, and the user is offered a way to keep working without AI.
   * - Hall Monitor unreachable: a student audience fails closed; an educator audience follows its
   *   profile's `failureMode`.
   * - A language-model call whose profile requires output moderation proceeds with `screenOutput`,
   *   so the Workshop holds the response for {@link screenModelOutput}.
   */
  async beforeModelCall(call: AiCallDescriptor): Promise<AiCallDecision> {
    const log = logger.with({ callId: call.callId, callSite: call.callSite });
    if (call.initiator.type === "agent") {
      // An agent initiator names a model, not a person, so no principal can be billed or moderated.
      log.info("AI call refused: agent initiators are no principal", { event: "ai_guard.denied", reason: "agent_initiator" });
      return deny("agent_initiator", this.#messages.notAllowed);
    }
    let context: GuardContext | null;
    try {
      context = await this.#resolver.resolve(call);
    } catch (error) {
      log.error("AI call refused: the district directory could not say who the call is for", { event: "ai_guard.failed", reason: "context_unavailable", error: error instanceof Error ? error.name : "unknown" });
      return deny("context_unavailable", this.#messages.aiUnavailable);
    }
    if (context === null) {
      log.info("AI call refused: initiator is no principal of this deployment", { event: "ai_guard.denied", reason: "unknown_principal" });
      return deny("unknown_principal", this.#messages.unknownPrincipal);
    }
    try {
      sourceEligibility(this.#config, context, Math.floor(Date.now() / 1000));
    } catch {
      log.info("AI call refused: source eligibility is unavailable", { event: "ai_guard.denied", reason: "source_eligibility_unavailable" });
      return deny("source_eligibility_unavailable", this.#messages.aiUnavailable);
    }
    const model: ModelRef = { provider: call.model.provider, modelId: call.model.id };
    const rate = rateFor(this.#config, model);
    if (rate === undefined) {
      // Refused rather than guessed: a model with no configured rate cannot be held for, so any
      // spend on it would escape the budget.
      log.warn("AI call refused: model has no configured rate", { event: "ai_guard.denied", reason: "model_unpriced" });
      return deny("model_unpriced", this.#messages.notAllowed);
    }

    const reserved = await this.#ledger.reserve({
      requestId: call.callId,
      principal: context.principal,
      workspace: context.workspace,
      model,
      estimatedMaxUsdNano: estimateMaxUsdNano(rate, call.maxOutputTokens),
      fundingPurpose: "generative",
    });
    if (reserved.outcome === "denied") {
      const reason = machineReason("ledger", reserved.reason);
      log.info("AI call refused by the ledger", { event: "ai_guard.denied", reason });
      return deny(reason, denialErrorCode(reserved.reason) === "budget-exceeded" ? this.#messages.budget : this.#messages.notAllowed);
    }
    if (reserved.status !== "held") {
      log.warn("AI call refused: its call ID was already settled", { event: "ai_guard.denied", reason: "request_already_completed" });
      return deny("request_already_completed", this.#messages.notAllowed);
    }

    let moderation: Moderation;
    try {
      moderation = await this.#moderate(call, context, log.with({ audience: context.audience }));
    } catch (error) {
      await this.#ledger.void(call.callId);
      log.error("AI call refused: the guard failed while moderating", { event: "ai_guard.failed", reason: "guard_error", error: error instanceof Error ? error.name : "unknown" });
      return deny("guard_error", this.#messages.aiUnavailable);
    }
    if (moderation.kind === "deny") {
      await this.#ledger.void(call.callId);
      log.info("AI call refused by moderation", { event: "ai_guard.denied", reason: moderation.reason });
      return deny(moderation.reason, moderation.message);
    }
    const languageModel = call.kind === "language-model";
    const screenOutput = languageModel && context.profile.outputModeration === "required";
    const coach = languageModel && moderation.coach;
    log.debug("AI call admitted", { event: "ai_guard.admitted", ...(coach ? { decision: "coach" } : {}) });
    return {
      action: "proceed",
      ...(screenOutput ? { screenOutput } : {}),
      ...(coach ? { instructions: this.#config.coachingInstructions } : {}),
    };
  }

  /**
   * Screens the response of a call it admitted with `screenOutput`, before the Workshop shows any
   * of it. The call is found by its generative reservation, which names who it was for; each chunk
   * of the response is evaluated as `interaction.output` (check `j` is `<callId>.o.c<j>`), held from
   * and settled to the safety pool as input checks are.
   *
   * - `allow` and `coach` release the response.
   * - `hold` and `block` withhold it with a neutral message; `support` with the supportive one.
   * - Everything else withholds: an unknown or already settled call, a safety pool that cannot
   *   fund the check, or Hall Monitor unreachable, whatever the profile's `failureMode`, since the
   *   response was meant to be screened.
   */
  async screenModelOutput(callId: string, output: AiCallModelOutput): Promise<AiCallOutputDecision> {
    const log = logger.with({ callId });
    const record = await this.#ledger.request(callId);
    const reservation = record?.reservation;
    if (reservation === undefined || reservation.fundingPurpose !== "generative" || record?.settlement !== undefined || record?.voided !== undefined) {
      log.warn("AI response withheld: its call is not one awaiting release", { event: "ai_guard.output.withheld", reason: "unknown_call" });
      return withhold("unknown_call", this.#messages.notAllowed);
    }
    const context = await this.#resolver.resolveAdmitted({ principalId: reservation.principalId, districtId: reservation.districtId }, reservation.workspace);
    if (context === null) {
      log.warn("AI response withheld: its principal is no longer served", { event: "ai_guard.output.withheld", reason: "unknown_principal" });
      return withhold("unknown_principal", this.#messages.notAllowed);
    }
    const checks = textChunks(output.parts).map((text, c) => ({ checkId: `${callId}.o.c${c}`, text }));
    let moderation: Moderation;
    try {
      moderation = await this.#evaluate(callId, context, checks, "interaction.output", log.with({ audience: context.audience }));
    } catch (error) {
      log.error("AI response withheld: the guard failed while screening it", { event: "ai_guard.failed", reason: "guard_error", error: error instanceof Error ? error.name : "unknown" });
      return withhold("guard_error", this.#messages.aiUnavailable);
    }
    if (moderation.kind === "deny") {
      log.info("AI response withheld by moderation", { event: "ai_guard.output.withheld", reason: moderation.reason });
      return withhold(moderation.reason, moderation.message);
    }
    log.debug("AI response released", { event: "ai_guard.output.released" });
    return RELEASE;
  }

  /**
   * Settles an admitted call's generative hold, exactly once per `callId`. A call that ended
   * without billing anything (failed or aborted with no reported tokens) is released instead.
   * The Workshop reports tokens but no cost, so the cost is the AI Gateway log's when the guard can
   * read one (`provider_reported`), else priced from the rate table merged with the shared price
   * book (`estimated`; see `priceSettlement`). Usage that is missing, or a model nothing prices, is
   * settled as `unknown`, which the ledger carries as a liability at the hold until reconciliation,
   * never as $0.
   */
  async afterModelCall(outcome: AiCallOutcome): Promise<void> {
    const log = logger.with({ callId: outcome.callId, status: outcome.status });
    const record = await this.#ledger.request(outcome.callId);
    if (record === null) {
      log.warn("AI call outcome has no reservation", { event: "ai_guard.settle.unknown_call" });
      return;
    }
    if (record.settlement !== undefined || record.voided !== undefined) {
      log.debug("AI call outcome already recorded", { event: "ai_guard.settle.duplicate" });
      return;
    }

    const usage = outcome.usage === undefined ? undefined : tokenUsageOf(outcome.usage);
    const billed = usage !== undefined && usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0;
    if (outcome.status !== "completed" && !billed) {
      const result = await this.#ledger.void(outcome.callId);
      log.info("AI call released", { event: "ai_guard.voided", outcome: result.outcome });
      return;
    }

    const gatewayLogId = outcome.aiGatewayLogId !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(outcome.aiGatewayLogId)
      ? { gatewayLogId: outcome.aiGatewayLogId }
      : {};
    const priced = await priceSettlement(this.#config, this.#gatewayLogs, {
      model: record.reservation.model,
      usage,
      at: record.reservation.reservedAt,
      ...gatewayLogId,
    });
    const { attempt } = priced;
    const result = await this.#ledger.settle(outcome.callId, { attempts: [attempt], ...(priced.priceBookId === undefined ? {} : { priceBookId: priced.priceBookId }) });
    const log2 = log.with({ outcome: result.outcome });
    if (result.outcome === "settled" || result.outcome === "already-voided") {
      log2.info("AI call settled", { event: "ai_guard.settled", reason: attempt.state, gatewayLookup: priced.gateway });
    } else {
      log2.warn("AI call settlement refused by the ledger", { event: "ai_guard.settle.refused" });
    }
  }

  async #moderate(call: AiCallDescriptor, context: GuardContext, log: Logger<GuardLogFields>): Promise<Moderation> {
    if (!context.profile.moderateInput && this.#config.moderation.governance === undefined) return { kind: "proceed", coach: false };
    const checks = call.newMessages.flatMap((message, m) => textChunks(message.parts).map((text, c) => ({ checkId: `${call.callId}.m${m}.c${c}`, text })));
    return this.#evaluate(call.callId, context, checks, "interaction.input", log);
  }

  // Has Hall Monitor evaluate each check in order, funding each from the safety pool, and stops at
  // the first that may not proceed. Input follows the profile when Hall Monitor is unavailable;
  // output, which was meant to be screened, always fails closed.
  async #evaluate(
    callId: string,
    context: GuardContext,
    checks: { checkId: string; text: string }[],
    kind: Extract<EvaluationKind, "interaction.input" | "interaction.output">,
    log: Logger<GuardLogFields>,
  ): Promise<Moderation> {
    if (checks.length === 0) return { kind: "proceed", coach: false };
    const output = kind === "interaction.output";
    if (this.#hallMonitor === null) return this.#unavailable(context, log, undefined, output);

    let coached = false;
    for (const { checkId, text } of checks) {
      const checkLog = log.with({ checkId });
      try {
        sourceEligibility(this.#config, context, Math.floor(Date.now() / 1000));
      } catch {
        checkLog.info("moderation refused: source eligibility is unavailable", { event: "ai_guard.denied", reason: "source_eligibility_unavailable" });
        return { kind: "deny", reason: "source_eligibility_unavailable", message: this.#messages.aiUnavailable };
      }
      const held = await this.#ledger.reserve({
        requestId: checkId,
        principal: context.principal,
        workspace: context.workspace,
        model: this.#config.moderation.model,
        estimatedMaxUsdNano: this.#config.moderation.maxUsdNanoPerCheck,
        fundingPurpose: "safety",
      });
      if (held.outcome === "denied") {
        // Moderation is never skipped to save money: with no safety funding, generative AI stops.
        const reason = held.reason === "safety-budget-exhausted" ? "safety_budget_exhausted" : machineReason("safety", held.reason);
        checkLog.warn("moderation cannot be funded; generative AI is off", { event: "ai_guard.safety.unfunded", reason });
        return { kind: "deny", reason, message: this.#messages.aiUnavailable };
      }

      let result: EvaluationResult;
      try {
        result = await this.#hallMonitor.evaluate(this.#evaluationRequest(callId, context, checkId, text, kind), { sourceContext: context });
      } catch (error) {
        // The call may have reached Hall Monitor and been billed, so its cost is unknown, not $0.
        await this.#ledger.settle(checkId, { attempts: [{ attemptIndex: 0, state: "unknown" }] });
        return this.#unavailable(context, checkLog, error, output);
      }
      if (result.receipt === null) {
        await this.#ledger.void(checkId);
      } else {
        await this.#ledger.settle(checkId, { attempts: receiptAttempts(result.receipt), ...receiptPriceBook(result.receipt) });
      }

      const fields = {
        decision: result.decision,
        reasonCodes: result.reasonCodes,
        evaluationId: result.evaluationId,
        ...(result.degraded === undefined ? {} : { degraded: result.degraded.reason }),
      };
      if (STOPPING.includes(result.decision)) {
        checkLog.info("moderation stopped an AI call", { event: "ai_guard.moderation.stopped", ...fields });
        return result.decision === "support"
          ? { kind: "deny", reason: "moderation_support", message: this.#messages.support }
          : { kind: "deny", reason: `moderation_${result.decision}`, message: output ? this.#messages.outputWithheld : this.#messages.blocked };
      }
      if (this.#config.moderation.governance !== undefined && result.degraded !== undefined) {
        checkLog.info("moderation refused a degraded governed result", { event: "ai_guard.denied", reason: "moderation_unavailable", ...fields });
        return { kind: "deny", reason: "moderation_unavailable", message: output ? this.#messages.outputWithheld : this.#messages.aiUnavailable };
      }
      const integrity = context.profile.answerAssistance !== "direct" && result.reasonCodes.some((code) => code.startsWith("academic_integrity."));
      if (result.decision === "coach" || integrity) {
        coached = true;
        checkLog.info("moderation coached an AI call; it proceeds", { event: "ai_guard.moderation.coach", ...fields });
      }
    }
    log.debug("moderation allowed an AI call", { event: "ai_guard.moderation.allowed", decision: coached ? "coach" : "allow" });
    return { kind: "proceed", coach: coached };
  }

  #evaluationRequest(callId: string, context: GuardContext, checkId: string, text: string, kind: EvaluationKind): EvaluationRequest {
    const { moderation } = this.#config;
    return {
      schemaVersion: SCHEMA_VERSION,
      requestId: checkId,
      // Unique per check, so a retried evaluation replays rather than re-bills.
      idempotencyKey: checkId,
      source: { product: "educateos", tenantId: moderation.tenantId, surface: moderation.surface },
      policy: { profileId: context.profile.hallMonitorProfileId, revision: context.profile.revision },
      context: {
        audience: context.audience,
        ...(context.gradeBand === undefined ? {} : { gradeBand: context.gradeBand }),
        costCenterId: moderation.costCenterId,
        parentRequestId: callId,
      },
      evaluationKind: kind,
      content: { type: "text", text },
    };
  }

  // Hall Monitor could not answer. Output and a student audience fail closed; otherwise an
  // educator's profile decides.
  #unavailable(context: GuardContext, log: Logger<GuardLogFields>, error: unknown, output: boolean): Moderation {
    const fields = error instanceof HallMonitorError
      ? { hallMonitorCode: error.code, ...(error.status === undefined ? {} : { hallMonitorStatus: error.status }) }
      : {};
    if (this.#config.moderation.governance === undefined && !output && context.audience === "educator" && context.profile.failureMode === "proceed") {
      log.warn("Hall Monitor unavailable; educator profile proceeds unmoderated", { event: "ai_guard.moderation.unavailable", reason: "moderation_unavailable_proceed", ...fields });
      return { kind: "proceed", coach: false };
    }
    log.warn("Hall Monitor unavailable; failing closed", { event: "ai_guard.moderation.unavailable", reason: "moderation_unavailable", ...fields });
    return { kind: "deny", reason: "moderation_unavailable", message: this.#messages.aiUnavailable };
  }
}
