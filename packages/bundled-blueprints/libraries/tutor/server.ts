/**
 * The tutor library's server entry (`@gadgets/bundled-blueprints/libraries/tutor/server`): what a
 * tutor's Durable Object needs, without the runtime. {@link TutorSession} keeps the conversation and
 * asks the model; the prompt module builds what the model is sent from the persona's rules and the
 * safety rules every tutor shares; `transcriptMarkdown` is the gadget's export.
 *
 * The entry imports nothing from `cloudflare:workers`: a blueprint's `Gadget` hands the session its
 * `ctx.storage` and its `env.LLM` binding.
 */

export {
  BAD_MESSAGE,
  MODEL_FAILED_MESSAGE,
  NO_MODEL_MESSAGE,
  PRIVATE_PLACEHOLDER,
  STORED_TURNS,
  TutorSession,
  type TutorModel,
  type TutorStorage,
  failureMessage,
  transcriptMarkdown,
} from "./src/session.ts";
export {
  HISTORY_CHARACTERS,
  HISTORY_TURNS,
  MAX_MESSAGE_LENGTH,
  MAX_TOPIC_LENGTH,
  cleanMessage,
  holdsPersonalDetails,
  promptFor,
  quoted,
  recentTurns,
  safetyRules,
  shapeReply,
  systemPromptFor,
} from "./src/prompt.ts";
export { TUTOR_GRADE_BANDS, type TutorGradeBand, type TutorPersona } from "./src/persona.ts";
export type { TutorApi, TutorReply, TutorState, TutorTurn } from "./src/protocol.ts";
