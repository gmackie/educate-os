// The tutor's page in jsdom, against a fake Durable Object and a fake speech engine.

import { describe, expect, it, vi } from "vitest";
import { mountTutor, type SpeechHost, type TutorApi, type TutorReply, type TutorState } from "../client.ts";
import { PERSONA_FIXTURE } from "./fixture.ts";

function fakeGadget(answer: (message: string, state: TutorState) => TutorReply) {
  let state: TutorState = { topic: "", turns: [] };
  const gadget: TutorApi = {
    getState: async () => state,
    ask: async (message) => {
      const result = answer(message, state);
      state = result.state;
      return result;
    },
    setTopic: async (topic) => (state = { ...state, topic }),
    reset: async () => (state = { topic: "", turns: [] }),
  };
  return gadget;
}

function fakeSpeech() {
  const spoken: string[] = [];
  class Utterance {
    rate = 1;
    readonly text: string;
    constructor(text: string) { this.text = text; }
  }
  const host: SpeechHost = {
    speechSynthesis: { speak: (u: SpeechSynthesisUtterance) => void spoken.push(u.text), cancel: vi.fn() },
    SpeechSynthesisUtterance: Utterance as unknown as typeof SpeechSynthesisUtterance,
  };
  return { host, spoken };
}

const answering = (reply: string) => (message: string, state: TutorState): TutorReply =>
  ({ ok: true, reply, state: { ...state, turns: [...state.turns, { role: "learner", text: message }, { role: "tutor", text: reply }] } });

describe("mountTutor", () => {
  it("shows who the tutor is, its grade band, its greeting and its quick replies", async () => {
    const root = document.createElement("div");
    const tutor = mountTutor({ gadget: fakeGadget(answering("ok")), persona: PERSONA_FIXTURE, root, speech: {} });
    await tutor.loaded;
    expect(root.querySelector("h1")?.textContent).toBe("Test Tutor");
    expect(root.querySelector(".tutor-band")?.textContent).toBe("Grades 6–8");
    expect(root.querySelector(".tutor-turn-tutor .tutor-text")?.textContent).toBe(PERSONA_FIXTURE.greeting);
    expect([...root.querySelectorAll(".tutor-quick")].map((button) => button.textContent)).toEqual(PERSONA_FIXTURE.quickReplies);
    expect(root.querySelector(".tutor-help")?.textContent).toBe(PERSONA_FIXTURE.helpNote);
    // No speech engine, no read-aloud buttons.
    expect(root.querySelector(".tutor-speak")).toBeNull();
    expect(document.getElementById("tutor-styles")?.textContent).toContain("@media print");
  });

  it("sends a quick reply, shows the answer, and reads it aloud when the persona asks", async () => {
    const root = document.createElement("div");
    const { host, spoken } = fakeSpeech();
    const tutor = mountTutor({ gadget: fakeGadget(answering("Great job! 🎉 What happened next?")), persona: PERSONA_FIXTURE, root, speech: host });
    await tutor.loaded;
    (root.querySelector(".tutor-quick") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(root.querySelectorAll(".tutor-turn-tutor")).toHaveLength(2));
    expect([...root.querySelectorAll(".tutor-text")].map((node) => node.textContent))
      .toEqual([PERSONA_FIXTURE.greeting, "Give me a hint", "Great job! 🎉 What happened next?"]);
    // Read without the emoji, which a voice would read by name.
    expect(spoken).toEqual(["Great job!  What happened next?"]);
    // Every reply has its own read-aloud button.
    (root.querySelectorAll(".tutor-speak")[0] as HTMLButtonElement).click();
    expect(spoken.at(-1)).toBe(PERSONA_FIXTURE.greeting);
  });

  it("shows a refusal as a note and gives the learner their message back", async () => {
    const root = document.createElement("div");
    const refusal = "This message can't be sent to the AI assistant.";
    const tutor = mountTutor({ gadget: fakeGadget((_message, state) => ({ ok: false, message: refusal, state })), persona: PERSONA_FIXTURE, root, speech: {} });
    await tutor.loaded;
    await tutor.send("something");
    expect(root.querySelector(".tutor-turn-notice .tutor-text")?.textContent).toBe(refusal);
    expect(root.querySelector(".tutor-status")?.textContent).toBe(refusal);
    expect((root.querySelector("textarea") as HTMLTextAreaElement).value).toBe("something");
  });
});
