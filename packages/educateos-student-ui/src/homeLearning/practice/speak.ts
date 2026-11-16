// Spoken directions for practice (ADR-0016), over the Learning Home's read-aloud. Called from tap
// handlers, so the browser treats each as user-initiated. Whole words and sentences only: browser
// speech is not a reliable model of an isolated letter sound, so sounds come from the adult. A
// family can turn reading aloud off; then nothing is spoken and a grown-up reads instead.
import { createContext, useContext } from "react";
import { canReadAloud, readAloud, stopReading } from "../../readAloud/speech.ts";

/** Whether the family lets practice read aloud. {@link PracticeApp} provides it from the server. */
export const ReadAloudSetting = createContext(false);

/** Says `text` aloud if reading aloud is `on` and this browser can, stopping anything else. */
export const say = (on: boolean, text: string): void => {
  if (on && canReadAloud()) readAloud("practice", text);
};

/** The family's reading-aloud setting, and a `speak` that honors it. */
export const useSpeech = (): { on: boolean; speak: (text: string) => void } => {
  const on = useContext(ReadAloudSetting);
  return { on, speak: (text) => say(on, text) };
};

/** Stops speaking. */
export const quiet = (): void => stopReading();
