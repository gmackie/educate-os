/**
 * The tutor's Durable Object as its page sees it, over Cap'n Web: what the page may ask and what it
 * gets back. Shared by the library's two sides; nothing here runs.
 */

/** One message of a conversation. */
export interface TutorTurn {
  /** Who wrote it. */
  role: "learner" | "tutor";
  /** What it says. */
  text: string;
}

/** What the page shows: the conversation and the topic it is about. */
export interface TutorState {
  /** What the learner said they are working on; empty when they have not said. */
  topic: string;
  /** The conversation, oldest first, the greeting not included. */
  turns: TutorTurn[];
}

/** The answer to {@link TutorApi.ask}. */
export type TutorReply =
  /** The tutor answered (or kept a private detail out of the conversation). */
  | { ok: true; reply: string; state: TutorState }
  /** No answer: the message was refused, or the AI is unavailable. `message` is for the learner. */
  | { ok: false; message: string; state: TutorState };

/** The Durable Object methods a tutor's page calls. */
export interface TutorApi {
  /** The conversation so far. */
  getState(): Promise<TutorState>;
  /** Sends the learner's message and returns the tutor's reply. */
  ask(message: string): Promise<TutorReply>;
  /** Sets what the learner is working on. */
  setTopic(topic: string): Promise<TutorState>;
  /** Forgets the conversation and the topic. */
  reset(): Promise<TutorState>;
}
