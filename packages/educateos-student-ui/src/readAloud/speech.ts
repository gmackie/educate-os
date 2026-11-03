// Read-aloud over the browser's own speech synthesis (SCHO-323). One thing is read at a time across
// the whole page, so the reading is a module-level store that every "Read to me" control watches.
// Nothing leaves the device: the Web Speech API's synthesis runs in the browser or the OS.

/** What is being read: which control started it, and the word being spoken when the browser says. */
export interface Reading {
  id: string;
  text: string;
  /** The word being spoken, as offsets into `text`. Not every voice reports word boundaries. */
  word?: { start: number; end: number };
  utterance: SpeechSynthesisUtterance;
}

let current: Reading | undefined;
const listeners = new Set<() => void>();

const set = (next: Reading | undefined) => {
  current = next;
  for (const listener of listeners) listener();
};

/** Subscribes to changes in what is being read, for `useSyncExternalStore`. */
export const subscribeReading = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** What is being read now, if anything. */
export const currentReading = (): Reading | undefined => current;

/** Whether this browser can read aloud. Where it can't, read-aloud controls are not shown at all. */
export const canReadAloud = (): boolean =>
  typeof window !== "undefined" && window.speechSynthesis !== undefined && typeof window.SpeechSynthesisUtterance === "function";

/** The word starting at `start` in `text`: up to its length if the browser gave one, else to the next space. */
const wordAt = (text: string, start: number, length: number | undefined): { start: number; end: number } => {
  if (length !== undefined && length > 0) return { start, end: start + length };
  const rest = text.slice(start).search(/\s/);
  return { start, end: rest === -1 ? text.length : start + rest };
};

/**
 * Reads `text` aloud for the control `id`, stopping anything else being read. A little slower than
 * the default rate, which young listeners follow more easily.
 */
export const readAloud = (id: string, text: string): void => {
  const synth = window.speechSynthesis;
  // Cleared first, so the cancelled utterance's own end event finds nothing of its own to clear.
  set(undefined);
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.9;
  const isCurrent = () => current?.utterance === utterance;
  utterance.addEventListener("boundary", (event) => {
    if (event.name === "word" && isCurrent()) set({ ...current!, word: wordAt(text, event.charIndex, event.charLength) });
  });
  const finished = () => {
    if (isCurrent()) set(undefined);
  };
  utterance.addEventListener("end", finished);
  utterance.addEventListener("error", finished);
  set({ id, text, utterance });
  synth.speak(utterance);
};

/** Stops reading aloud. */
export const stopReading = (): void => {
  set(undefined);
  if (canReadAloud()) window.speechSynthesis.cancel();
};
