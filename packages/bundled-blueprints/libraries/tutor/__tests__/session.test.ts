// @vitest-environment node
// The conversation loop over an in-memory storage and a scripted model: what the model is sent, what
// is kept, and what the learner is told when the model or the guard says no.

import { describe, expect, it } from "vitest";
import {
  BAD_MESSAGE,
  MODEL_FAILED_MESSAGE,
  NO_MODEL_MESSAGE,
  PRIVATE_PLACEHOLDER,
  STORED_TURNS,
  TutorSession,
  type TutorModel,
  type TutorStorage,
  failureMessage,
  systemPromptFor,
  transcriptMarkdown,
} from "../server.ts";
import { PERSONA_FIXTURE } from "./fixture.ts";

function memory(): TutorStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async put<T>(key: string, value: T) { data.set(key, structuredClone(value)); },
  };
}

function scripted(answer: (prompt: string) => string | Promise<string>) {
  const calls: { prompt: string; systemPrompt?: string }[] = [];
  const model: TutorModel = { async run(options) { calls.push(options); return answer(options.prompt); } };
  return { calls, model };
}

describe("TutorSession", () => {
  it("sends the persona's system prompt and the quoted conversation, and keeps both turns", async () => {
    const { calls, model } = scripted(() => "What have you tried?");
    const session = new TutorSession(PERSONA_FIXTURE, memory(), () => model);
    await session.setTopic("Fractions");
    expect(await session.ask("  Help with 1/2 + 1/3  ")).toEqual({
      ok: true, reply: "What have you tried?",
      state: { topic: "Fractions", turns: [{ role: "learner", text: "Help with 1/2 + 1/3" }, { role: "tutor", text: "What have you tried?" }] },
    });
    await session.ask("I added the tops");
    expect(calls[0]!.systemPrompt).toBe(systemPromptFor(PERSONA_FIXTURE));
    expect(calls[1]!.prompt).toContain("Learner: Help with 1/2 + 1/3\nTest Tutor: What have you tried?");
    expect(calls[1]!.prompt).toContain('"""\nFractions\n"""');
    expect((await session.getState()).turns).toHaveLength(4);
  });

  it("never sends or keeps a message holding contact details or an address", async () => {
    const { calls, model } = scripted(() => "unused");
    const storage = memory();
    const session = new TutorSession(PERSONA_FIXTURE, storage, () => model);
    const result = await session.ask("my phone is 555 123 4567, text me");
    expect(result).toMatchObject({ ok: true, reply: PERSONA_FIXTURE.privacyReply });
    expect(calls).toEqual([]);
    expect(JSON.stringify([...storage.data.values()])).not.toContain("555");
    expect((await session.getState()).turns[0]).toEqual({ role: "learner", text: PRIVATE_PLACEHOLDER });
    // Nor a topic, which would be sent with every turn.
    expect((await session.setTopic("Essay. Email me at kid@example.com")).topic).toBe("");
  });

  it("tells the learner what the guard said when it refuses, and keeps nothing", async () => {
    const refusal = "This message can't be sent to the AI assistant. Try rephrasing it, or ask your teacher for help.";
    const session = new TutorSession(PERSONA_FIXTURE, memory(), () => ({ run: async () => { throw new Error(refusal); } }));
    expect(await session.ask("something")).toEqual({ ok: false, message: refusal, state: { topic: "", turns: [] } });
  });

  it("refuses an empty or overlong message, and says when no model is connected", async () => {
    const session = new TutorSession(PERSONA_FIXTURE, memory(), () => undefined);
    expect(await session.ask("   ")).toMatchObject({ ok: false, message: BAD_MESSAGE });
    expect(await session.ask("hello")).toMatchObject({ ok: false, message: NO_MODEL_MESSAGE });
  });

  it("answers one message at a time, so neither loses the other's turn", async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const { model } = scripted(async (prompt) => {
      const message = prompt.split("The learner's new message:")[1]!;
      if (message.includes("one")) await first;
      return message.includes("one") ? "reply one" : "reply two";
    });
    const session = new TutorSession(PERSONA_FIXTURE, memory(), () => model);
    const a = session.ask("one");
    const b = session.ask("two");
    release();
    await Promise.all([a, b]);
    expect((await session.getState()).turns.map((turn) => turn.text)).toEqual(["one", "reply one", "two", "reply two"]);
  });

  it("keeps at most STORED_TURNS turns, and forgets everything on reset", async () => {
    const storage = memory();
    storage.data.set("tutor:v1", { topic: "t", turns: Array.from({ length: STORED_TURNS }, (_, i) => ({ role: "learner", text: `${i}` })) });
    const session = new TutorSession(PERSONA_FIXTURE, storage, () => ({ run: async () => "ok" }));
    expect((await session.ask("new")).state.turns).toHaveLength(STORED_TURNS);
    expect(await session.reset()).toEqual({ topic: "", turns: [] });
  });
});

describe("failureMessage", () => {
  it("passes a short message through and hides anything that is not meant for a learner", () => {
    expect(failureMessage(new Error("Error: The AI budget for this work has been used up."))).toBe("The AI budget for this work has been used up.");
    expect(failureMessage(new Error("x".repeat(500)))).toBe(MODEL_FAILED_MESSAGE);
    expect(failureMessage(new Error("boom\n    at run (worker.js:1:2)"))).toBe(MODEL_FAILED_MESSAGE);
    expect(failureMessage(new Error("see https://internal.example/trace"))).toBe(MODEL_FAILED_MESSAGE);
    expect(failureMessage(undefined)).toBe(MODEL_FAILED_MESSAGE);
  });
});

describe("transcriptMarkdown", () => {
  it("is the greeting and the conversation, for a teacher", () => {
    expect(transcriptMarkdown(PERSONA_FIXTURE, { topic: "Fractions", turns: [{ role: "learner", text: "Hi" }, { role: "tutor", text: "Hello!" }] }))
      .toBe("# Test Tutor\n\n_A tutor for tests._\n\n**Working on:** Fractions\n\n**Test Tutor:** Hello! What are we working on?\n\n**Me:** Hi\n\n**Test Tutor:** Hello!\n");
  });
});
