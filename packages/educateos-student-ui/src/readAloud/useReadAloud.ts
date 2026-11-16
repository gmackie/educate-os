import { useEffect, useId, useSyncExternalStore } from "react";
import { useAnnounce } from "../AppContext.tsx";
import { canReadAloud, currentReading, readAloud, stopReading, subscribeReading } from "./speech.ts";

/** One piece of text that can be read aloud, and its state. */
export interface ReadAloudControl {
  /** Whether the browser can read aloud. When it can't, nothing about read-aloud is shown. */
  available: boolean;
  /** Whether this text is being read now. */
  reading: boolean;
  /** The word being spoken, as offsets into the text, when the browser reports it. */
  word: { start: number; end: number } | undefined;
  text: string;
  /** What the text is, for the control's accessible name, such as "the instructions". */
  label: string;
  /** Starts reading, or stops if this text is being read. */
  toggle: () => void;
}

/**
 * Read-aloud for `text`. Reading stops if the text's control leaves the page, so a reading never
 * outlives the step or question it belongs to.
 */
export const useReadAloud = (text: string, label: string): ReadAloudControl => {
  const id = useId();
  const announce = useAnnounce();
  const reading = useSyncExternalStore(subscribeReading, currentReading, () => undefined);
  const mine = reading?.id === id;

  useEffect(() => () => {
    if (currentReading()?.id === id) stopReading();
  }, [id]);

  return {
    available: canReadAloud(),
    reading: mine,
    word: mine ? reading.word : undefined,
    text,
    label,
    toggle: () => {
      if (mine) {
        stopReading();
        return;
      }
      readAloud(id, text);
      announce(`Reading ${label} aloud.`);
    },
  };
};
