// Presenter mode (SCHO-279), for showing Cedar Valley to a room: `?presenter` in the page's query,
// beside `?district=cedarvalley`. The tour keeps only its step titles, each step can be jumped to,
// one key switches persona through the portal, and a reset starts the district and the tour over.
import { useEffect, useEffectEvent } from "react";
import type { PersonaId } from "../districts/index.ts";

/** Whether a page's query string asks for presenter mode. */
export const presenterFromSearch = (search: string): boolean => new URLSearchParams(search).has("presenter");

/** What a key does in presenter mode. */
export type PresenterCommand = { kind: "persona"; persona: PersonaId } | { kind: "help" };

/** The keys presenter mode answers, in the order its help lists them. */
export const PRESENTER_KEYS: readonly { key: string; does: string; command: PresenterCommand }[] = [
  { key: "1", does: "Sign in as Elaine Park, the administrator, through the portal", command: { kind: "persona", persona: "admin" } },
  { key: "2", does: "Sign in as Dana Whitaker, the teacher, through the portal", command: { kind: "persona", persona: "teacher" } },
  { key: "3", does: "Sign in as Rowan Ellis, the student, through the portal", command: { kind: "persona", persona: "student" } },
  { key: "?", does: "Show or hide these shortcuts", command: { kind: "help" } },
];

/** Whether a key press belongs to whatever has focus: a field being typed in, or a key combination. */
function isTyping(event: Pick<KeyboardEvent, "target" | "altKey" | "ctrlKey" | "metaKey">): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return true;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']") !== null;
}

/** The command a key press gives in presenter mode, if any. */
export function presenterCommand(event: Pick<KeyboardEvent, "key" | "target" | "altKey" | "ctrlKey" | "metaKey" | "defaultPrevented">): PresenterCommand | undefined {
  if (event.defaultPrevented || isTyping(event)) return undefined;
  return PRESENTER_KEYS.find(({ key }) => key === event.key)?.command;
}

/** Calls `onCommand` with each presenter command typed on the page while `enabled`. */
export function usePresenterKeys(enabled: boolean, onCommand: (command: PresenterCommand) => void): void {
  const command = useEffectEvent(onCommand);
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const pressed = presenterCommand(event);
      if (pressed === undefined) return;
      event.preventDefault();
      command(pressed);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
