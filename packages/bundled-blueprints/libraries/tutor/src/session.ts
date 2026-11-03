/**
 * A tutor's conversation, as its Durable Object keeps it: the topic, the turns, and one exchange with
 * the model at a time. It is written against a two-method storage and the model binding's `run`, not
 * the runtime, so a blueprint's `Gadget` only hands over `ctx.storage` and `env.LLM`, and a test can
 * hand over a map and a function.
 */

import type { TutorPersona } from "./persona.ts";
import type { TutorApi, TutorReply, TutorState, TutorTurn } from "./protocol.ts";
import {
  MAX_TOPIC_LENGTH,
  cleanMessage,
  holdsPersonalDetails,
  promptFor,
  shapeReply,
  systemPromptFor,
} from "./prompt.ts";

/** The storage a session keeps its state in: a Durable Object's `ctx.storage` will do. */
export interface TutorStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** The Workshop's language-model binding (`LanguageModelBinding`), as the blueprint binds it as `LLM`. */
export interface TutorModel {
  run(options: { prompt: string; systemPrompt?: string }): Promise<string>;
}

/** How many turns are kept; older ones are dropped, and only {@link HISTORY_TURNS} reach a prompt. */
export const STORED_TURNS = 200;

/** What the page tells a learner whose gadget has no model bound. */
export const NO_MODEL_MESSAGE = "This tutor has no AI model connected yet. Ask your teacher to set it up.";
/** What the page tells a learner when the model failed without a message meant for them. */
export const MODEL_FAILED_MESSAGE = "The tutor can't answer right now. Try again in a little while, or ask your teacher.";
/** What the page tells a learner whose message was empty or too long. */
export const BAD_MESSAGE = "That message is empty or too long. Try a shorter one.";

/** What a learner's withheld message is kept as, so the conversation reads on without it. */
export const PRIVATE_PLACEHOLDER = "(I shared something private, so it wasn't kept.)";

const STATE_KEY = "tutor:v1";

/**
 * The learner-facing part of a model failure: the AI guard's refusals ("This message can't be sent
 * to the AI assistant…") are written for the learner and reach the gadget as the error's message.
 * Anything long, or that reads like a stack, gets the generic {@link MODEL_FAILED_MESSAGE}.
 */
export function failureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw.replace(/^(?:\w*Error:\s*)+/, "").trim();
  if (message === "" || message.length > 400 || /\n\s+at\s|https?:\/\//.test(message)) return MODEL_FAILED_MESSAGE;
  return message;
}

/** One tutor's conversation over `storage`, answering with `model`. */
export class TutorSession implements TutorApi {
  readonly #persona: TutorPersona;
  readonly #storage: TutorStorage;
  readonly #model: () => TutorModel | undefined;
  // One exchange at a time, so two quick messages cannot both read the same history and one lose
  // the other's turn.
  #queue: Promise<unknown> = Promise.resolve();

  /** `model` is read at each turn, so a binding connected after the object started is used. */
  constructor(persona: TutorPersona, storage: TutorStorage, model: () => TutorModel | undefined) {
    this.#persona = persona;
    this.#storage = storage;
    this.#model = model;
  }

  async getState(): Promise<TutorState> {
    const stored = await this.#storage.get<TutorState>(STATE_KEY);
    return { topic: stored?.topic ?? "", turns: stored?.turns ?? [] };
  }

  setTopic(topic: string): Promise<TutorState> {
    return this.#serially(async () => {
      const clean = cleanMessage(topic, MAX_TOPIC_LENGTH) ?? "";
      const state = await this.getState();
      // A topic is sent to the model with every turn, so it is never kept if it holds private details.
      const next = { ...state, topic: holdsPersonalDetails(clean) ? "" : clean };
      await this.#storage.put(STATE_KEY, next);
      return next;
    });
  }

  reset(): Promise<TutorState> {
    return this.#serially(async () => {
      const next: TutorState = { topic: "", turns: [] };
      await this.#storage.put(STATE_KEY, next);
      return next;
    });
  }

  ask(message: string): Promise<TutorReply> {
    return this.#serially(async (): Promise<TutorReply> => {
      const state = await this.getState();
      const clean = cleanMessage(message);
      if (clean === null) return { ok: false, message: BAD_MESSAGE, state };
      if (holdsPersonalDetails(clean)) {
        // Neither sent nor kept: the model never sees it, and the conversation holds a placeholder.
        const reply = this.#persona.privacyReply;
        return { ok: true, reply, state: await this.#append(state, [{ role: "learner", text: PRIVATE_PLACEHOLDER }, { role: "tutor", text: reply }]) };
      }
      const model = this.#model();
      if (model === undefined) return { ok: false, message: NO_MODEL_MESSAGE, state };
      let reply: string;
      try {
        const raw = await model.run({
          systemPrompt: systemPromptFor(this.#persona),
          prompt: promptFor(this.#persona, { topic: state.topic, turns: state.turns, message: clean }),
        });
        reply = shapeReply(this.#persona, raw);
      } catch (error) {
        return { ok: false, message: failureMessage(error), state };
      }
      if (reply === "") return { ok: false, message: MODEL_FAILED_MESSAGE, state };
      return { ok: true, reply, state: await this.#append(state, [{ role: "learner", text: clean }, { role: "tutor", text: reply }]) };
    });
  }

  async #append(state: TutorState, turns: TutorTurn[]): Promise<TutorState> {
    const next = { ...state, turns: [...state.turns, ...turns].slice(-STORED_TURNS) };
    await this.#storage.put(STATE_KEY, next);
    return next;
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => {});
    return result;
  }
}

/** A conversation as Markdown, for the gadget's export: what a learner can hand their teacher. */
export function transcriptMarkdown(persona: TutorPersona, state: TutorState): string {
  const lines = [`# ${persona.name}`, "", `_${persona.tagline}_`, ""];
  if (state.topic !== "") lines.push(`**Working on:** ${state.topic}`, "");
  lines.push(`**${persona.name}:** ${persona.greeting}`, "");
  for (const turn of state.turns) lines.push(`**${turn.role === "learner" ? "Me" : persona.name}:** ${turn.text}`, "");
  return lines.join("\n");
}
