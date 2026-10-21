// Unsaved work, kept in this tab's sessionStorage until the district has it. A draft exists exactly
// while there are changes the district has not saved, so a failed save, a dropped connection or a
// reload never loses what the student typed, and "is there a draft?" is the same question as "is
// there unsaved work?".
import { useSyncExternalStore } from "react";

const PREFIX = "schoolos.student.draft:";
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** Reads the draft under `key`, if there is one. */
export const readDraft = (key: string): string | undefined => {
  try {
    return sessionStorage.getItem(PREFIX + key) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * Keeps `text` as the draft under `key`. Returns false when the browser would not store it (storage
 * full or disabled), so the caller can tell the student their changes exist only on screen.
 */
export const writeDraft = (key: string, text: string): boolean => {
  try {
    sessionStorage.setItem(PREFIX + key, text);
    return true;
  } catch {
    return false;
  } finally {
    notify();
  }
};

/** Drops the draft under `key`, once the district has saved it. */
export const clearDraft = (key: string): void => {
  try {
    sessionStorage.removeItem(PREFIX + key);
  } catch {
    // Nothing was stored, so there is nothing to drop.
  }
  notify();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether each of `keys` has unsaved work, re-rendering when any draft changes. */
export const useHasDrafts = (keys: readonly string[]): boolean[] => {
  const snapshot = useSyncExternalStore(subscribe, () => keys.map((key) => (readDraft(key) === undefined ? "0" : "1")).join(""));
  return [...snapshot].map((flag) => flag === "1");
};
