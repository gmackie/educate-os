// Spoken directions for practice (ADR-0016), over the Learning Home's read-aloud. Called from tap
// handlers, so the browser treats each as user-initiated. Whole words and sentences only: browser
// speech is not a reliable model of an isolated letter sound, so sounds come from the adult.
import { canReadAloud, readAloud, stopReading } from "../../readAloud/speech.ts";

/** Says `text` aloud if this browser can, stopping anything else. */
export const speak = (text: string): void => {
  if (canReadAloud()) readAloud("practice", text);
};

/** Stops speaking. */
export const quiet = (): void => stopReading();
