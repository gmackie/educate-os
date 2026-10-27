// Each row of docs/educateos/hall-monitor/ingress-matrix.md that reaches a model, driven with an AI
// call guard bound as AI_CALL_GUARD: the guard is asked before the model, with the row's call site
// and the text that came in. The guard here denies every call, so nothing reaches a provider.
//
// Most rows run their real entry point on a real OverseerDurableObject, with the user DOs faked.
// Three are driven at a narrower seam, said where they are: the gadget model bindings (their
// gatekeeper DO, without the facet that hosts it), the binding-name and workspace-title one-shots
// (the methods that make them; their callers sit deep in connection and code-change flows), and
// compaction (runAgent on a `/compact` turn, with a guarded faux model).

import { describe, expect, it, vi } from "vitest";
import { env as testEnv, type RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type {
  AgentSpawnerConfig, AiChatAuthorInfo, AiChatMessage, AiModelConfig,
} from "@gadgets/workshop-shared/api";
import type {
  AiCallDecision, AiCallDescriptor, AiCallSite,
} from "@gadgets/workshop-shared/ai-call-guard";
import { runAgent } from "../src/agent";
import type { AgentSpawnerBinding } from "../src/agent-spawner-binding";
import { guardModelHandle } from "../src/ai-call-guard.js";
import { AiCallDeniedError } from "../src/ai-invoke.js";
import {
  DecisionModelGatekeeper, LanguageModelGatekeeper, type ModelHandle,
} from "../src/ai-models.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { FakeChatResponseTarget } from "./response-target";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const MODEL: AiChatAuthorInfo = { type: "agent", id: "claude", name: "Claude" };
const CHAT_ID = 1;
// Resolves without network access; the guard denies before any request is sent.
const CONFIG: AiModelConfig =
    { provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "key" };
const AI_MODEL = { profile: MODEL, config: CONFIG };

const DENY: AiCallDecision =
    { action: "deny", reason: "test_denied", message: "Denied by the test guard." };

// Records every call and denies it.
function recordingGuard() {
  let calls: AiCallDescriptor[] = [];
  let guard = {
    async beforeModelCall(call: AiCallDescriptor) {
      calls.push(call);
      return DENY;
    },
    async afterModelCall() {},
  };
  return { calls, guard };
}

function texts(call: AiCallDescriptor): string[] {
  return call.newMessages.flatMap(message =>
      message.parts.flatMap(part => part.type === "text" ? [part.text] : []));
}

// The calls from `site`, once there is at least one.
async function callsFrom(calls: AiCallDescriptor[], site: AiCallSite) {
  await vi.waitFor(() => expect(calls.map(call => call.callSite)).toContain(site));
  return calls.filter(call => call.callSite === site);
}

function expectText(call: AiCallDescriptor, text: string) {
  expect(texts(call).some(part => part.includes(text)), `${call.callSite} passes "${text}"`)
      .toBe(true);
}

let counter = 0;

// Runs `fn` on a fresh overseer whose model calls go through `guard`, and whose user DOs are faked:
// every user is the owner, with CONFIG as both agent and quick model.
async function withOverseer(
    guard: ReturnType<typeof recordingGuard>["guard"],
    fn: (impl: any, instance: OverseerDurableObject) => Promise<void>): Promise<void> {
  let stub = testEnv.TEST_OVERSEER.getByName(`ai-call-ingress-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.env = { ...impl.env, AI_CALL_GUARD: guard, CF_AI_GATEWAY: undefined };
    impl.ownerId = OWNER_USER_ID;
    let user = {
      id: { toString: () => OWNER_USER_ID },
      whoamiIfExists: async () => OWNER,
      getChatContext: async () => ({ profile: OWNER, aiModel: AI_MODEL, quickModel: CONFIG }),
      getExternalMessageChatContext: async () => ({ profile: OWNER, aiModel: AI_MODEL }),
      getCloudflareGatekeeperAccount: async () => null,
      publishNotification: async () => {},
    };
    impl.users = {
      idFromString: (id: string) => id,
      get: () => user,
      getByName: () => user,
    };
    impl.emitChatStreamEvent = () => {};
    await fn(impl, instance);
  });
}

function seedChat(impl: any, messages: [AiChatAuthorInfo, string][] = []) {
  impl.storage.chatMeta.put(
      { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
  for (let [author, message] of messages) {
    let sequence = impl.nextChatSequence(CHAT_ID);
    impl.storage.chats.put({
      chatId: CHAT_ID, sequence, timestamp: new Date(sequence),
      author, type: "message", message,
    } satisfies AiChatMessage);
  }
}

const CLIENT_USER = { id: { toString: () => OWNER_USER_ID } };

describe("every ingress path that reaches a model asks the guard", () => {
  it("new chat (row 1): the turn as chat.message, and the title as chat.title", async () => {
    let { calls, guard } = recordingGuard();
    await withOverseer(guard, async impl => {
      let text = "Plan a lesson on equivalent fractions.";
      await impl.newChat(CLIENT_USER, { profile: OWNER, aiModel: AI_MODEL, quickModel: CONFIG },
          text);
      expectText((await callsFrom(calls, "chat.message"))[0], text);
      expectText((await callsFrom(calls, "chat.title"))[0], text);
      await impl.waitForAllAgentsToComplete();
    });
  });

  it("chat message (row 2): chat.message", async () => {
    let { calls, guard } = recordingGuard();
    await withOverseer(guard, async impl => {
      seedChat(impl, [[OWNER, "Hi"], [MODEL, "Hello."]]);
      let text = "Now grade this essay on photosynthesis.";
      await impl.sendChatMessage(CLIENT_USER, { profile: OWNER, aiModel: AI_MODEL }, CHAT_ID, text);
      let [call] = await callsFrom(calls, "chat.message");
      expectText(call, text);
      expect(call).toMatchObject({ chatId: CHAT_ID, initiator: { type: "user", id: OWNER.id } });
      await impl.waitForAllAgentsToComplete();
    });
  });

  // The turn has nothing to answer (its history ends with the agent's reply), so it ends without
  // a model call, and the steer it never read prompts the next turn. A steer the agent reads
  // mid-turn instead arrives as a user message of that turn's next step, under the turn's label.
  it("steer (row 3): the turn it prompts as chat.steer", async () => {
    let { calls, guard } = recordingGuard();
    await withOverseer(guard, async impl => {
      seedChat(impl, [[OWNER, "Hi"], [MODEL, "Hello."]]);
      impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(CHAT_ID), activeAgent: MODEL });
      impl.startAgent(CHAT_ID, AI_MODEL, OWNER, OWNER_USER_ID, "chat.message");
      let text = "Actually, make it about decimals.";
      expect(impl.steerRunningTurn(CHAT_ID, OWNER_USER_ID, OWNER, text)).toBe(true);

      let [call] = await callsFrom(calls, "chat.steer");
      expectText(call, text);
      expect(calls.map(each => each.callSite)).toEqual(["chat.steer"]);
      await impl.waitForAllAgentsToComplete();
    });
  });

  it("external agent message (row 6): chat.external", async () => {
    let { calls, guard } = recordingGuard();
    await withOverseer(guard, async (impl, instance) => {
      using target: RpcStub<FakeChatResponseTarget> = await impl.ctx.restore({
        type: "test-response-target", name: crypto.randomUUID(),
      });
      await target.setAvailable(true);
      let text = "Summarize today's attendance.";
      let result = await instance.receiveExternalMessage({
        callerEmail: OWNER.id, externalChatKey: "ext-1", idempotencyKey: "idem-1", prompt: text,
        chatGatewayRpcTarget: target, title: "External",
      } as any);
      expect(result.accepted).toBe(true);
      expectText((await callsFrom(calls, "chat.external"))[0], text);
      expect(calls.map(call => call.callSite)).not.toContain("chat.message");
      await impl.waitForAllAgentsToComplete();
    });
  });

  it("agent callback (row 8): agent.callback", async () => {
    let { calls, guard } = recordingGuard();
    await withOverseer(guard, async impl => {
      seedChat(impl);
      await impl.deliverAgentCallback(
          CHAT_ID, "composeEmail", ["parents of 5B"], OWNER_USER_ID, MODEL.id);
      let [call] = await callsFrom(calls, "agent.callback");
      expectText(call, "composeEmail");
      expect(call.initiator.type).toBe("gadget");
      await impl.waitForAllAgentsToComplete();
    });
  });

  it("agent spawn (row 9): agent.spawn", async () => {
    let { calls, guard } = recordingGuard();
    await withOverseer(guard, async impl => {
      let config: Omit<AgentSpawnerConfig, "env"> = { displayName: "Spawner", modelId: MODEL.id };
      // Follow the real facet/session route: the spawner's approval queue, rather than an
      // overseer entrypoint, now owns spawning and reads the accepted binding edges.
      let cls = impl.ctx.exports.AgentSpawnerGatekeeper({ props: {
        config, creatorUserId: OWNER_USER_ID,
      } });
      using client = await impl.addGatekeeper(
          cls, { type: "agentSpawner", config }, OWNER_USER_ID, undefined, {});
      using binding: RpcStub<AgentSpawnerBinding> = await client.openSession();
      let text = "Draft feedback for every submitted essay.";
      await binding.spawn("Feedback", text);
      let [call] = await callsFrom(calls, "agent.spawn");
      expectText(call, text);
      expect(call.initiator).toEqual({ type: "gadget", id: OWNER.id });
      expect(calls.map(each => each.callSite)).toEqual(["agent.spawn"]);
      await impl.waitForAllAgentsToComplete();
    });
  });

  it("binding name (row 14): chat.binding-name", async () => {
    let { calls, guard } = recordingGuard();
    await withOverseer(guard, async impl => {
      let subject = "A spreadsheet of the class's reading levels.";
      let quick = { config: CONFIG, initiator: OWNER };
      expect(await impl.generateBindingName(subject, new Set(), quick)).toBeUndefined();
      expectText((await callsFrom(calls, "chat.binding-name"))[0], subject);
    });
  });

  it("workspace title (row 14): gadget.title", async () => {
    let { calls, guard } = recordingGuard();
    await withOverseer(guard, async impl => {
      let text = "Build me a quiz on the water cycle.";
      seedChat(impl, [[OWNER, text]]);
      await impl.generateGadgetTitle(CHAT_ID, CONFIG, OWNER);
      expectText((await callsFrom(calls, "gadget.title"))[0], text);
    });
  });
});

describe("gadget model bindings, at their gatekeeper", () => {
  const GADGET: AiChatAuthorInfo = { type: "gadget", id: OWNER.id, name: "Quiz" };

  // A gatekeeper DO as the overseer's facet would host it, minus the facet.
  function gatekeeper<T extends object>(cls: { prototype: T }, config: AiModelConfig,
                                        guard: ReturnType<typeof recordingGuard>["guard"]): T {
    let instance = Object.create(cls.prototype) as T;
    Object.assign(instance, {
      env: { ...testEnv, AI_CALL_GUARD: guard, CF_AI_GATEWAY: undefined },
      ctx: { props: {
        displayName: "Model", config, initiator: GADGET,
        metadata: { source: "model-binding", gadgetId: "gadget-1", automated: true },
      } },
    });
    return instance;
  }

  it("LLM binding (row 11): gadget.llm", async () => {
    let { calls, guard } = recordingGuard();
    let session = await gatekeeper(LanguageModelGatekeeper, CONFIG, guard)
        .startSession(undefined as never);
    let text = "Explain osmosis to a ten-year-old.";
    await expect(session.run({ prompt: text, systemPrompt: "Be brief." }))
        .rejects.toBeInstanceOf(AiCallDeniedError);
    expect(calls.map(call => call.callSite)).toEqual(["gadget.llm"]);
    expectText(calls[0], text);
    expectText(calls[0], "Be brief.");
  });

  it("decision binding (row 12): gadget.decision", async () => {
    let { calls, guard } = recordingGuard();
    let session = await gatekeeper(DecisionModelGatekeeper,
        { provider: "cloudflare", model: "@cf/cloudflare/clef", apiToken: "key", accountId: "a" },
        guard).startSession(undefined as never);
    let text = "My child missed the field trip form.";
    await expect(session.decide({
      state: { message: text },
      questions: { urgent: { type: "bool", instructions: "Is this urgent?",
                             criteria: { true: "Needs action today.", false: "Can wait." } } },
    })).rejects.toThrow();
    expect(calls.map(call => call.callSite)).toEqual(["gadget.decision"]);
    expectText(calls[0], text);
  });
});

describe("compaction (row 14)", () => {
  it("asks the guard as chat.compaction on the turn's own handle", async () => {
    let calls: AiCallDescriptor[] = [];
    let guard = {
      async beforeModelCall(call: AiCallDescriptor): Promise<AiCallDecision> {
        calls.push(call);
        return { action: "proceed" };
      },
      async afterModelCall() {},
    };
    await withOverseer(guard, async impl => {
      seedChat(impl, [
        [OWNER, "first request"], [MODEL, "first response"],
        [OWNER, "follow-up"], [MODEL, "second response"],
      ]);
      let sequence = impl.nextChatSequence(CHAT_ID);
      impl.storage.chats.put({
        chatId: CHAT_ID, sequence, timestamp: new Date(sequence), author: OWNER,
        type: "slashCommand",
        request: { id: { builtin: true, commandId: "compact" }, args: "" },
      });
      let faux = createFauxCore({ models: [{ id: "faux-model" }] });
      faux.setResponses([fauxAssistantMessage(fauxText("The summary."))]);
      let handle: ModelHandle = { model: faux.getModel(), stream: faux.stream };
      guardModelHandle(guard, handle, {
        callSite: "chat.message", initiator: { type: "user", id: OWNER.id },
        model: { provider: "cloudflare", id: "faux-model" },
        gadgetId: `compaction-${++counter}`, chatId: CHAT_ID,
      });

      await runAgent(impl, handle, CHAT_ID, MODEL, new AbortController().signal, OWNER,
          { provider: "cloudflare", model: "faux-model", apiToken: "" });

      expect(calls.map(call => call.callSite)).toEqual(["chat.compaction"]);
      expectText(calls[0], "first request");
    });
  });
});
