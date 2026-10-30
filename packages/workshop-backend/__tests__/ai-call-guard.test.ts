// The optional AI call guard: what the kernel passes it around each model call, and how its
// decisions reach callers. Model calls run against pi's faux provider.

import { describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage, fauxText, fauxThinking,
  fauxToolCall,
  type AssistantMessage, type AssistantMessageEvent,
  type ClassifierResult, type Context,
} from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo, AiChatMetadata, AiChatMessage } from "@gadgets/workshop-shared/api";
import type {
  AiCallDecision, AiCallDescriptor, AiCallModelOutput, AiCallOutcome, AiCallOutputDecision,
} from "@gadgets/workshop-shared/ai-call-guard";
import { runAgent, type AgentHooks } from "../src/agent";
import { aiCallGuardFor, guardDecisionModel, guardModelHandle, type AiCallScope } from "../src/ai-call-guard.js";
import { AiCallDeniedError, completeText } from "../src/ai-invoke.js";
import { getModel, type ModelHandle } from "../src/ai-models.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GadgetRecord } from "../src/storage-schema/overseer-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 1;

// The kernel remembers which messages each chat passed, so every test uses its own workspace.
let counter = 0;
function scope(): AiCallScope {
  return {
    callSite: "chat.agent", initiator: { type: "user", id: OWNER.id },
    model: { provider: "cloudflare", id: "faux-model" }, gadgetId: `gadget-${++counter}`,
    chatId: CHAT_ID,
  };
}

const PROCEED: AiCallDecision = { action: "proceed" };
const DENY: AiCallDecision =
    { action: "deny", reason: "budget_exhausted", message: "Out of budget." };

function fakeGuard(decide: (call: AiCallDescriptor) => AiCallDecision = () => PROCEED) {
  let calls: AiCallDescriptor[] = [];
  let outcomes: AiCallOutcome[] = [];
  return {
    calls, outcomes,
    guard: {
      async beforeModelCall(call: AiCallDescriptor) {
        calls.push(call);
        return decide(call);
      },
      async afterModelCall(outcome: AiCallOutcome) {
        outcomes.push(outcome);
      },
    },
  };
}

function fauxHandle(steps: AssistantMessage[] = []) {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  faux.setResponses(steps);
  let handle: ModelHandle = { model: faux.getModel(), stream: faux.stream };
  return { faux, handle };
}

function user(text: string): Context["messages"][number] {
  return { role: "user", content: text, timestamp: 0 };
}

function texts(call: AiCallDescriptor): string[] {
  return call.newMessages.flatMap(message =>
      message.parts.flatMap(part => part.type === "text" ? [part.text] : []));
}

describe("aiCallGuardFor (SCHO-307)", () => {
  it("is the bound guard, or none when the deployment does not require one", () => {
    let { guard } = fakeGuard();
    expect(aiCallGuardFor({ AI_CALL_GUARD: guard, REQUIRE_AI_CALL_GUARD: "true" })).toBe(guard);
    for (let required of [undefined, "", "false"]) expect(aiCallGuardFor({ REQUIRE_AI_CALL_GUARD: required })).toBeUndefined();
  });

  it.each(["true", "1", "yes"])("denies every call when REQUIRE_AI_CALL_GUARD=%s and no guard is bound", async (required) => {
    let { handle } = fauxHandle([fauxAssistantMessage(fauxText("Unguarded answer."))]);
    guardModelHandle(aiCallGuardFor({ REQUIRE_AI_CALL_GUARD: required }), handle, scope());
    await expect(completeText(handle, { prompt: "Hi" })).rejects.toMatchObject({ name: "AiCallDeniedError", reason: "guard_unavailable" });
  });
});

describe("guardModelHandle", () => {
  it("leaves a handle untouched when no guard is bound", () => {
    let { handle } = fauxHandle();
    let stream = handle.stream;
    expect(guardModelHandle(undefined, handle, scope())).toBe(handle);
    expect(handle.stream).toBe(stream);
  });

  it("passes each message once per chat, and only after a call that proceeded", async () => {
    let { handle } = fauxHandle([
      fauxAssistantMessage(fauxText("One.")), fauxAssistantMessage(fauxText("Two.")),
    ]);
    let { calls, guard } = fakeGuard(call => texts(call).includes("deny me") ? DENY : PROCEED);
    let chat = scope();
    guardModelHandle(guard, handle, chat);

    let first = await handle.stream(handle.model, { messages: [user("Hi")] }).result();
    // A second handle on the same chat, as the next turn would get.
    let next = fauxHandle([fauxAssistantMessage(fauxText("Three."))]).handle;
    guardModelHandle(guard, next, chat);
    let denied = await next.stream(next.model,
        { messages: [user("Hi"), first, user("deny me")] }).result();
    await next.stream(next.model, { messages: [user("Hi"), first, user("deny me")] }).result();

    expect(denied).toMatchObject({ stopReason: "error", errorMessage: "Out of budget." });
    expect(calls.map(texts)).toEqual([["Hi"], ["deny me"], ["deny me"]]);
    expect(calls.map(call => call.callSite)).toEqual(["chat.agent", "chat.agent", "chat.agent"]);
    expect(new Set(calls.map(call => call.callId)).size).toBe(3);
    // The retried request sends the same context, so it is the same logical request.
    expect(calls[1].logicalRequestId).toBe(calls[2].logicalRequestId);
    expect(calls[0].logicalRequestId).not.toBe(calls[1].logicalRequestId);
  });

  it("shares one record across a chat's agent turns, whatever started them", async () => {
    let { handle } = fauxHandle([fauxAssistantMessage(fauxText("One."))]);
    let { calls, guard } = fakeGuard();
    let chat = { ...scope(), callSite: "chat.message" as const };
    guardModelHandle(guard, handle, chat);
    let first = await handle.stream(handle.model, { messages: [user("Hi")] }).result();
    let steered = fauxHandle([fauxAssistantMessage(fauxText("Two."))]).handle;
    guardModelHandle(guard, steered, { ...chat, callSite: "chat.steer" });
    await steered.stream(steered.model, { messages: [user("Hi"), first, user("Faster")] }).result();
    // A title is not an agent turn: it is shown what it sends.
    let title = fauxHandle([fauxAssistantMessage(fauxText("Chat"))]).handle;
    guardModelHandle(guard, title, { ...chat, callSite: "chat.title" });
    await completeText(title, { prompt: "Hi" });

    expect(calls.map(call => [call.callSite, texts(call)])).toEqual([
      ["chat.message", ["Hi"]], ["chat.steer", ["Faster"]], ["chat.title", ["Hi"]],
    ]);
  });

  it("asks as the call site a request names, on any handle", async () => {
    let { handle } = fauxHandle([fauxAssistantMessage(fauxText("Summary."))]);
    let { calls, guard } = fakeGuard();
    guardModelHandle(guard, handle, scope());

    await completeText(handle, { prompt: "Summarize", callSite: "chat.compaction" });

    expect(calls.map(call => call.callSite)).toEqual(["chat.compaction"]);
  });

  it("sends a denied request nowhere, and completeText throws the denial", async () => {
    let { faux, handle } = fauxHandle([fauxAssistantMessage(fauxText("Never."))]);
    let { outcomes, guard } = fakeGuard(() => DENY);
    guardModelHandle(guard, handle, scope());

    let error = await completeText(handle, { prompt: "Hi" }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AiCallDeniedError);
    expect(error).toMatchObject({ message: "Out of budget.", reason: "budget_exhausted" });
    expect(faux.state.callCount).toBe(0);
    expect(outcomes).toEqual([]);
  });

  it("denies when the guard fails", async () => {
    let { faux, handle } = fauxHandle([fauxAssistantMessage(fauxText("Never."))]);
    guardModelHandle({
      beforeModelCall: async () => { throw new Error("guard down"); },
      afterModelCall: async () => {},
    }, handle, scope());

    await expect(completeText(handle, { prompt: "Hi" }))
        .rejects.toMatchObject({ name: "AiCallDeniedError", reason: "guard_unavailable" });
    expect(faux.state.callCount).toBe(0);
  });

  it.each([19_000, 60_000])("waits for replay screening with a bounded deadline (%i ms)", async elapsedMs => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      const { faux, handle } = fauxHandle([fauxAssistantMessage(fauxText("Checked."))]);
      let release!: (decision: AiCallDecision) => void;
      let started!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      guardModelHandle({
        beforeModelCall: () => {
          started();
          return new Promise<AiCallDecision>(resolve => { release = resolve; });
        },
        afterModelCall: async () => {},
      }, handle, scope());
      const result = completeText(handle, { prompt: "Resume this conversation" });
      const outcome = result.then(value => ({ value }), error => ({ error }));
      await entered;
      await vi.advanceTimersByTimeAsync(elapsedMs);
      expect(faux.state.callCount).toBe(0);
      release(PROCEED);
      if (elapsedMs < 60_000) {
        expect(await outcome).toEqual({ value: "Checked." });
      } else {
        expect(await outcome).toMatchObject({ error: { reason: "guard_unavailable" } });
        expect(faux.state.callCount).toBe(0);
      }
      expect(timeout).toHaveBeenCalledWith(60_000);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("denies when the call is stopped while the guard is still deciding", async () => {
    let { faux, handle } = fauxHandle([fauxAssistantMessage(fauxText("Never."))]);
    guardModelHandle({
      beforeModelCall: () => new Promise<AiCallDecision>(() => {}),
      afterModelCall: async () => {},
    }, handle, scope());
    let stop = new AbortController();

    let response = handle.stream(handle.model, { messages: [user("Hi")] }, { signal: stop.signal });
    stop.abort();

    expect(await response.result()).toMatchObject({ stopReason: "error" });
    expect(faux.state.callCount).toBe(0);
  });

  it("settles each call with the usage the provider reported, and its gateway log", async () => {
    let answer = fauxAssistantMessage(fauxText("OK"));
    answer.usage = { ...answer.usage, input: 10, output: 5, cacheRead: 100, cacheWrite: 20 };
    // The faux provider reports its own usage, so this provider answers with `answer` as it is.
    let handle: ModelHandle = {
      model: fauxHandle().handle.model,
      stream: () => {
        handle.lastResponse = { status: 200, aiGatewayLogId: "log-1" };
        let stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: answer });
        return stream;
      },
    };
    let { calls, outcomes, guard } = fakeGuard();
    guardModelHandle(guard, handle, scope());

    expect(await completeText(handle, { prompt: "Hi", maxTokens: 64 })).toBe("OK");

    expect(calls[0]).toMatchObject({ kind: "language-model", maxOutputTokens: 64 });
    await vi.waitFor(() => expect(outcomes).toEqual([{
      callId: calls[0].callId, status: "completed",
      usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }, aiGatewayLogId: "log-1",
    }]));
  });

  it("finishes the call when settling fails", async () => {
    let { handle } = fauxHandle([fauxAssistantMessage(fauxText("OK"))]);
    let settled = Promise.withResolvers<void>();
    guardModelHandle({
      beforeModelCall: async () => ({ action: "proceed" }),
      afterModelCall: async () => {
        settled.resolve();
        throw new Error("ledger down");
      },
    }, handle, scope());

    expect(await completeText(handle, { prompt: "Hi" })).toBe("OK");
    await settled.promise;
  });

  it("guards the handles getModel() returns when the deployment binds a guard", async () => {
    let { calls, outcomes, guard } = fakeGuard();
    let env = { AI_CALL_GUARD: guard } as unknown as Cloudflare.Env;
    let handle = getModel(env,
        { provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "key" }, OWNER,
        { metadata: { source: "thread-title", gadgetId: "gadget-title", chatId: 3 } });
    let fetch = vi.fn(async () =>
        Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 }));

    await handle.stream(handle.model, { messages: [user("Name this chat")] },
        { fetch, maxRetries: 0 }).result();

    expect(fetch).toHaveBeenCalledOnce();
    expect(calls).toMatchObject([{
      kind: "language-model", callSite: "chat.title", gadgetId: "gadget-title", chatId: 3,
      initiator: { type: "user", id: OWNER.id },
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    }]);
    expect(texts(calls[0])).toEqual(["Name this chat"]);
    await vi.waitFor(() => expect(outcomes).toMatchObject([{ status: "failed" }]));
  });
});

describe("output screening", () => {
  const SCREEN: AiCallDecision = { action: "proceed", screenOutput: true };
  const WITHHOLD: AiCallOutputDecision =
      { action: "withhold", reason: "moderation_block", message: "That reply was held back." };

  // A provider the test feeds by hand, so it can see what the guarded stream forwards mid-response.
  function manualHandle() {
    let inner = createAssistantMessageEventStream();
    let handle: ModelHandle = { model: fauxHandle().handle.model, stream: () => inner };
    return { inner, handle };
  }

  // A faux provider answering `answer` that records each event it streams.
  function recordingHandle(answer: AssistantMessage) {
    let faux = fauxHandle([answer]).handle;
    let sent: AssistantMessageEvent[] = [];
    let handle: ModelHandle = {
      model: faux.model,
      stream: (...args) => {
        let out = createAssistantMessageEventStream();
        void (async () => {
          for await (let event of faux.stream(...args)) {
            sent.push(event);
            out.push(event);
          }
        })();
        return out;
      },
    };
    return { handle, sent };
  }

  function screeningGuard(
      screen: (output: AiCallModelOutput) => Promise<AiCallOutputDecision>,
      decision: AiCallDecision = SCREEN) {
    let fake = fakeGuard(() => decision);
    let screened: { callId: string; output: AiCallModelOutput }[] = [];
    let guard = {
      ...fake.guard,
      async screenModelOutput(callId: string, output: AiCallModelOutput) {
        screened.push({ callId, output });
        return screen(output);
      },
    };
    return { ...fake, guard, screened };
  }

  async function collectFrom(handle: ModelHandle, signal?: AbortSignal) {
    let stream = handle.stream(handle.model, { messages: [user("Hi")] }, { signal });
    let events: AssistantMessageEvent[] = [];
    let done = (async () => { for await (let event of stream) events.push(event); })();
    return { events, done, result: () => stream.result() };
  }

  it("forwards events as they arrive when the guard does not ask to screen", async () => {
    let { inner, handle } = manualHandle();
    let { guard, screened } = screeningGuard(async () => WITHHOLD, PROCEED);
    guardModelHandle(guard, handle, scope());
    let answer = fauxAssistantMessage(fauxText("Streaming."));

    let { events, done } = await collectFrom(handle);
    inner.push({ type: "start", partial: answer });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    inner.push({ type: "done", reason: "stop", message: answer });
    await done;

    expect(events.map(event => event.type)).toEqual(["start", "done"]);
    expect(screened).toEqual([]);
  });

  it("holds every event until the guard releases the finished response", async () => {
    let { inner, handle } = manualHandle();
    let release = Promise.withResolvers<AiCallOutputDecision>();
    let { guard, screened } = screeningGuard(() => release.promise);
    guardModelHandle(guard, handle, scope());
    let answer = fauxAssistantMessage(fauxText("Held."));

    let { events, done } = await collectFrom(handle);
    inner.push({ type: "start", partial: answer });
    inner.push({ type: "done", reason: "stop", message: answer });
    await vi.waitFor(() => expect(screened).toHaveLength(1));
    expect(events).toEqual([]);
    release.resolve({ action: "release" });
    await done;

    expect(events.map(event => event.type)).toEqual(["start", "done"]);
  });

  it("replays exactly the events the provider streamed, and screens text, reasoning and tool calls", async () => {
    let answer = fauxAssistantMessage(
        [fauxThinking("Mitosis first."), fauxText("Cells divide."), fauxToolCall("noSuchTool", { note: "hi" })]);
    let { handle, sent } = recordingHandle(answer);
    let { calls, outcomes, guard, screened } = screeningGuard(async () => ({ action: "release" }));
    guardModelHandle(guard, handle, scope());

    let events = await Array.fromAsync(handle.stream(handle.model, { messages: [user("Hi")] }));

    expect(sent.length).toBeGreaterThan(5);
    expect(events).toEqual(sent);
    expect(screened).toEqual([{ callId: calls[0].callId, output: {
      parts: [
        { type: "text", text: "Mitosis first." }, { type: "text", text: "Cells divide." },
        { type: "text", text: 'noSuchTool({"note":"hi"})' },
      ],
      // The output is screened for the reader the call was admitted for.
      initiator: { type: "user", id: OWNER.id },
    } }]);
    await vi.waitFor(() => expect(outcomes).toMatchObject([{ status: "completed" }]));
  });

  it("forwards nothing of a withheld response, and fails as a denial", async () => {
    let { handle } = fauxHandle([fauxAssistantMessage(fauxText("Something unsafe."))]);
    let { outcomes, guard } = screeningGuard(async () => WITHHOLD);
    guardModelHandle(guard, handle, scope());

    let { events, done, result } = await collectFrom(handle);
    await done;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error: { content: [] } });
    expect(JSON.stringify(events)).not.toContain("unsafe");
    expect(await result()).toMatchObject(
        { stopReason: "error", errorMessage: "That reply was held back." });
    // The provider still billed the call, so it settles as completed.
    await vi.waitFor(() => expect(outcomes).toMatchObject([{ status: "completed" }]));

    let next = fauxHandle([fauxAssistantMessage(fauxText("Unsafe again."))]).handle;
    guardModelHandle(guard, next, scope());
    await expect(completeText(next, { prompt: "Hi" })).rejects.toMatchObject(
        { name: "AiCallDeniedError", message: "That reply was held back.", reason: "moderation_block" });
  });

  it("screens a response that is only a tool call, whose arguments a page or file may show (SCHO-307)", async () => {
    let { handle } = fauxHandle([fauxAssistantMessage(fauxToolCall("writeFile", { text: "Something unsafe." }))]);
    let { guard, screened } = screeningGuard(async () => WITHHOLD);
    guardModelHandle(guard, handle, scope());

    let { events, done } = await collectFrom(handle);
    await done;
    expect(screened).toMatchObject([{ output: { parts: [{ type: "text", text: 'writeFile({"text":"Something unsafe."})' }] } }]);
    expect(events).toMatchObject([{ type: "error" }]);
    expect(JSON.stringify(events)).not.toContain("unsafe");
  });

  it("releases a response with nothing to show without asking", async () => {
    let { handle } = fauxHandle([fauxAssistantMessage([])]);
    let { guard, screened } = screeningGuard(async () => WITHHOLD);
    guardModelHandle(guard, handle, scope());

    expect(await handle.stream(handle.model, { messages: [user("Hi")] }).result()).toMatchObject({ content: [] });
    expect(screened).toEqual([]);
  });

  it.each([
    ["fails", () => Promise.reject(new Error("guard down"))],
    ["answers nonsense", async () => ({ action: "maybe" }) as unknown as AiCallOutputDecision],
  ])("withholds the response when the guard %s", async (_case, screen) => {
    let { handle } = fauxHandle([fauxAssistantMessage(fauxText("Unchecked."))]);
    guardModelHandle(screeningGuard(screen).guard, handle, scope());

    let { events, done } = await collectFrom(handle);
    await done;

    expect(events).toMatchObject([{ type: "error" }]);
    expect(JSON.stringify(events)).not.toContain("Unchecked");
  });

  it("withholds the response when a guard asks to screen but cannot", async () => {
    let { handle } = fauxHandle([fauxAssistantMessage(fauxText("Unchecked."))]);
    guardModelHandle(fakeGuard(() => SCREEN).guard, handle, scope());

    await expect(completeText(handle, { prompt: "Hi" }))
        .rejects.toMatchObject({ name: "AiCallDeniedError", reason: "guard_unavailable" });
  });

  it("withholds the response when the call is stopped while it is being screened", async () => {
    let { handle } = fauxHandle([fauxAssistantMessage(fauxText("Unchecked."))]);
    let { guard, screened } = screeningGuard(() => new Promise(() => {}));
    guardModelHandle(guard, handle, scope());
    let stop = new AbortController();

    let { events, done } = await collectFrom(handle, stop.signal);
    await vi.waitFor(() => expect(screened).toHaveLength(1));
    stop.abort();
    await done;

    expect(events).toMatchObject([{ type: "error" }]);
  });
});

describe("instructions", () => {
  const COACH = "Ask for their attempt before helping.";

  // A faux provider that records the context each request reaches it with.
  function seeingHandle(steps: AssistantMessage[]) {
    let { faux, handle: inner } = fauxHandle(steps);
    let seen: Context[] = [];
    let handle: ModelHandle = {
      model: inner.model,
      stream: (model, context, options) => {
        seen.push(structuredClone(context));
        return inner.stream(model, context, options);
      },
    };
    return { faux, handle, seen };
  }

  it("appends them to that request alone, as a final system message", async () => {
    let { handle, seen } = seeingHandle([
      fauxAssistantMessage(fauxText("Coached.")), fauxAssistantMessage(fauxText("Plain.")),
    ]);
    let { calls, guard } = fakeGuard(call =>
        texts(call).includes("Help") ? { action: "proceed", instructions: COACH } : PROCEED);
    guardModelHandle(guard, handle, scope());
    let context: Context = { systemPrompt: "Be brief.", messages: [user("Help")] };

    let first = await handle.stream(handle.model, context).result();
    context.messages.push(first, user("Thanks"));
    await handle.stream(handle.model, context).result();

    expect(seen[0]).toMatchObject({ systemPrompt: "Be brief.", messages: [
      { role: "user", content: "Help" }, { role: "system", content: COACH },
    ] });
    expect(seen[1].messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(context.messages).toHaveLength(3);
    // The guard is never shown its own instructions as something new.
    expect(calls.map(texts)).toEqual([["Be brief.", "Help"], ["Thanks"]]);
  });

  it("denies a call whose instructions are too long, without sending it", async () => {
    let { faux, handle } = seeingHandle([fauxAssistantMessage(fauxText("Never."))]);
    guardModelHandle(fakeGuard(() => ({ action: "proceed", instructions: "x".repeat(4001) })).guard,
        handle, scope());

    await expect(completeText(handle, { prompt: "Hi" }))
        .rejects.toMatchObject({ name: "AiCallDeniedError", reason: "invalid_decision" });
    expect(faux.state.callCount).toBe(0);
  });

  it("are not kept in an agent turn's transcript or the chat's history", () =>
    withImpl(async impl => {
      let { handle, seen } = seeingHandle([
        fauxAssistantMessage(fauxToolCall("noSuchTool", {})),
        fauxAssistantMessage(fauxText("Done.")),
      ]);
      let { guard } = fakeGuard(call =>
          call.newMessages.some(message => message.role === "user")
              ? { action: "proceed", instructions: COACH } : PROCEED);
      guardModelHandle(guard, handle, scope());

      await runTurn(impl, handle);

      expect(seen).toHaveLength(2);
      expect(seen[0].messages.at(-1)).toMatchObject({ role: "system", content: COACH });
      expect(JSON.stringify(seen[1])).not.toContain(COACH);
      let history = [...impl.storage.chats.list()];
      expect(history.length).toBeGreaterThan(1);
      expect(JSON.stringify(history)).not.toContain(COACH);
    }));
});

describe("guardDecisionModel", () => {
  const CONTEXT = {
    state: { message: "My order never arrived." },
    questions: { refund: { type: "bool" as const, instructions: "Wants a refund?" } },
  };
  const RESULT: ClassifierResult = {
    api: "cloudflare-workers-ai-system-one", provider: "cloudflare-workers-ai", model: "clef",
    answers: { refund: { type: "bool", probability: 0.9 } }, stopReason: "stop", timestamp: 0,
    usage: { input: 152, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 152,
             cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const decisionScope = (): AiCallScope => ({ ...scope(), callSite: "gadget.decision" });

  it("passes the decision's state and questions, and settles its usage", async () => {
    let decide = vi.fn(async () => RESULT);
    let { calls, outcomes, guard } = fakeGuard();

    expect(await guardDecisionModel(guard, decide, decisionScope())(CONTEXT)).toBe(RESULT);

    expect(calls).toMatchObject([{ kind: "decision-model", callSite: "gadget.decision" }]);
    expect(JSON.parse(texts(calls[0])[0])).toEqual(CONTEXT);
    await vi.waitFor(() => expect(outcomes).toEqual([{
      callId: calls[0].callId, status: "completed",
      usage: { input: 152, output: 0, cacheRead: 0, cacheWrite: 0 },
    }]));
  });

  it("throws a denial without asking the model", async () => {
    let decide = vi.fn(async () => RESULT);
    let { guard } = fakeGuard(() => DENY);

    await expect(guardDecisionModel(guard, decide, decisionScope())(CONTEXT))
        .rejects.toBeInstanceOf(AiCallDeniedError);
    expect(decide).not.toHaveBeenCalled();
  });
});

// The OverseerImpl members these tests drive; the class itself is private to overseer.ts.
interface OverseerInternals extends AgentHooks {
  storage: {
    gadgets: { put(record: GadgetRecord): void };
    chatMeta: { put(meta: AiChatMetadata): void };
    chats: { put(message: AiChatMessage): void; list(): Iterable<AiChatMessage> };
  };
  nextChatSequence(chatId: number): number;
}

async function withImpl(fn: (impl: OverseerInternals) => Promise<void>): Promise<void> {
  let stub = testEnv.TEST_OVERSEER.getByName(`ai-call-guard-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: OverseerInternals }).impl;
    impl.storage.gadgets.put({
      type: "gadget", id: 100, title: "App", created: new Date(0), bindingName: "APP",
      bindings: {},
    });
    impl.storage.chatMeta.put(
        { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    impl.storage.chats.put({
      chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
      author: OWNER, type: "message", message: "Hi",
    });
    impl.emitChatStreamEvent = () => {};
    await fn(impl);
  });
}

function runTurn(impl: OverseerInternals, handle: ModelHandle): Promise<void> {
  return runAgent(impl, handle, CHAT_ID, { type: "agent", id: "faux-model", name: "Faux" },
      new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" });
}

describe("an agent turn with a guard", () => {
  it("asks the guard before each step, passing only what it adds", () => withImpl(async impl => {
    let { faux, handle } = fauxHandle([
      // A call to a tool that does not exist, which pi answers with an error tool result.
      fauxAssistantMessage(fauxToolCall("noSuchTool", {})),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    let { calls, outcomes, guard } = fakeGuard();
    guardModelHandle(guard, handle, scope());

    await runTurn(impl, handle);

    expect(faux.state.callCount).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].newMessages.map(message => message.role)).toContain("user");
    expect(texts(calls[0])).toContain("Hi");
    expect(calls[1].newMessages).toMatchObject([{ role: "toolResult", toolName: "noSuchTool" }]);
    await vi.waitFor(() => expect(outcomes.map(outcome => outcome.status))
        .toEqual(["completed", "completed"]));
  }));

  it("fails the turn with the denial before the model is asked", () => withImpl(async impl => {
    let { faux, handle } = fauxHandle([fauxAssistantMessage(fauxText("Never."))]);
    guardModelHandle(fakeGuard(() => DENY).guard, handle, scope());

    await expect(runTurn(impl, handle)).rejects.toMatchObject(
        { name: "AiCallDeniedError", message: "Out of budget.", reason: "budget_exhausted" });
    expect(faux.state.callCount).toBe(0);
  }));
});
