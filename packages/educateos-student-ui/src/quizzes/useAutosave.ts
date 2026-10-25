import { useEffect, useRef, useState } from "react";
import type { QuizResponse } from "../model.ts";

/** How long after the last change answers are saved. */
export const AUTOSAVE_DELAY_MS = 2500;

/** Where autosave stands, for the status line beside the questions. */
export type SaveState = { status: "idle" } | { status: "saving" } | { status: "saved"; at: string } | { status: "failed"; error: unknown };

type Answer = { itemId: string; response: QuizResponse };

/**
 * Saves changed answers a moment after the student stops changing them, or at once on `flush`
 * (when they leave a question). Only answers changed since the last save are sent; a failed save
 * keeps them to send again with the next. `stop` drops anything pending, once the attempt is over.
 */
export const useAutosave = (save: (answers: Answer[]) => Promise<{ savedAt: string }>) => {
  const [state, setState] = useState<SaveState>({ status: "idle" });
  const pending = useRef(new Map<string, QuizResponse>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopped = useRef(false);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  const flush = async () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (stopped.current || pending.current.size === 0) return;
    const answers = [...pending.current].map(([itemId, response]) => ({ itemId, response }));
    pending.current.clear();
    setState({ status: "saving" });
    try {
      const { savedAt } = await saveRef.current(answers);
      setState({ status: "saved", at: savedAt });
    } catch (error) {
      // Keep what failed unless a newer answer to the same question is already waiting.
      for (const answer of answers) if (!pending.current.has(answer.itemId)) pending.current.set(answer.itemId, answer.response);
      setState({ status: "failed", error });
    }
  };

  const change = (itemId: string, response: QuizResponse) => {
    if (stopped.current) return;
    pending.current.set(itemId, response);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
  };

  const stop = () => {
    stopped.current = true;
    clearTimeout(timer.current);
    pending.current.clear();
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  return { state, change, flush: () => void flush(), stop };
};
