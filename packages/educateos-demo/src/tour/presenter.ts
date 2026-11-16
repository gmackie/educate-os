// Presenter mode (SCHO-279, SCHO-324), for showing the demo to a room: `?presenter` in the page's
// query. In Cedar Valley the Clever tour keeps only its step titles, each step can be jumped to, one
// key switches persona through the portal, and a reset starts the district and the tour over. In
// Northfield the K-12 story tour is driven from the keyboard: a number opens its step, the arrows
// step through it.
import { useEffect, useEffectEvent } from "react";
import type { PersonaId } from "../districts/index.ts";

/** Whether a page's query string asks for presenter mode. */
export const presenterFromSearch = (search: string): boolean => new URLSearchParams(search).has("presenter");

/** What a key does in presenter mode. */
export type PresenterCommand =
  | { kind: "persona"; persona: PersonaId }
  | { kind: "step"; index: number }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "help" };

/** One key presenter mode answers, and what its help says it does. */
export interface PresenterKey {
  key: string;
  /** The key as the help shows it, when not the key itself, such as "→". */
  label?: string;
  does: string;
  command: PresenterCommand;
}

const HELP: PresenterKey = { key: "?", does: "Show or hide these shortcuts", command: { kind: "help" } };

/** Cedar Valley's keys, in the order its help lists them. */
export const PRESENTER_KEYS: readonly PresenterKey[] = [
  { key: "1", does: "Sign in as Elaine Park, the administrator, through the portal", command: { kind: "persona", persona: "admin" } },
  { key: "2", does: "Sign in as Dana Whitaker, the teacher, through the portal", command: { kind: "persona", persona: "teacher" } },
  { key: "3", does: "Sign in as Rowan Ellis, the student, through the portal", command: { kind: "persona", persona: "student" } },
  HELP,
];

/** The K-12 story tour's keys, for a tour of `steps` steps. */
export const storyPresenterKeys = (steps: readonly { title: string }[]): readonly PresenterKey[] => [
  ...steps.slice(0, 9).map((step, index): PresenterKey => ({ key: String(index + 1), does: step.title, command: { kind: "step", index } })),
  { key: "ArrowRight", label: "→", does: "Next step", command: { kind: "next" } },
  { key: "ArrowLeft", label: "←", does: "Previous step", command: { kind: "previous" } },
  HELP,
];

/** Whether a key press belongs to whatever has focus: a field being typed in, or a key combination. */
function isTyping(event: Pick<KeyboardEvent, "target" | "altKey" | "ctrlKey" | "metaKey">): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return true;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='slider'], [role='tablist']") !== null;
}

/** The command a key press gives in presenter mode, if any. */
export function presenterCommand(
  event: Pick<KeyboardEvent, "key" | "target" | "altKey" | "ctrlKey" | "metaKey" | "defaultPrevented">,
  keys: readonly PresenterKey[] = PRESENTER_KEYS,
): PresenterCommand | undefined {
  if (event.defaultPrevented || isTyping(event)) return undefined;
  return keys.find(({ key }) => key === event.key)?.command;
}

/** Calls `onCommand` with each presenter command typed on the page while `enabled`. */
export function usePresenterKeys(enabled: boolean, onCommand: (command: PresenterCommand) => void, keys: readonly PresenterKey[] = PRESENTER_KEYS): void {
  const command = useEffectEvent(onCommand);
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const pressed = presenterCommand(event, keys);
      if (pressed === undefined) return;
      event.preventDefault();
      command(pressed);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, keys]);
}
