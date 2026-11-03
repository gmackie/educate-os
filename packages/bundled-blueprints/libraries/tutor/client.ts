/**
 * The tutor library's browser entry (`@gadgets/bundled-blueprints/libraries/tutor/client`): the page
 * every bundled tutor shares. `mountTutor` draws it from a {@link TutorPersona} and wires it to the
 * tutor's Durable Object; `speak` reads a reply aloud with the browser's speech synthesis.
 */

export { type MountTutorOptions, type MountedTutor, mountTutor } from "./src/ui.ts";
export { TUTOR_GRADE_BANDS, type TutorGradeBand, type TutorPersona } from "./src/persona.ts";
export type { TutorApi, TutorReply, TutorState, TutorTurn } from "./src/protocol.ts";
export { canSpeak, speak, stopSpeaking, type SpeechHost } from "./src/speech.ts";
