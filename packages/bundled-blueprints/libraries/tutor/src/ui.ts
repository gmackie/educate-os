/**
 * A tutor's page: the tutor's name and face, an optional "what are we working on" field, the
 * conversation, one-tap replies and the message box. Every reply can be read aloud; a persona that
 * asks for it (the youngest readers') hears each one as it arrives. Everything is drawn from the
 * persona, so the four tutors share this page and differ in what they say and how big it is.
 */

import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import type { TutorPersona } from "./persona.ts";
import type { TutorApi, TutorState, TutorTurn } from "./protocol.ts";
import { canSpeak, speak, stopSpeaking, type SpeechHost } from "./speech.ts";
import { TUTOR_STYLES } from "./styles.ts";

/** What {@link mountTutor} needs. */
export interface MountTutorOptions {
  /** The tutor's Durable Object, as the Workshop's iframe bootstrap provides it. */
  gadget: Pick<TutorApi, "getState" | "ask" | "setTopic" | "reset">;
  /** Who the tutor is. */
  persona: TutorPersona;
  /** Where to draw the page; the document's body by default. */
  root?: HTMLElement;
  /** Speech synthesis; the window's by default. */
  speech?: SpeechHost;
}

/** The page {@link mountTutor} drew, for a test to drive. */
export interface MountedTutor {
  /** The page's root element. */
  element: HTMLElement;
  /** Sends `text` as the learner, as the Send button does; resolves once the reply is shown. */
  send(text: string): Promise<void>;
  /** Resolves once the stored conversation has been loaded. */
  loaded: Promise<void>;
}

const GRADE_LABELS: Record<TutorPersona["band"], string> = {
  "K-2": "Grades K–2",
  "3-5": "Grades 3–5",
  "6-8": "Grades 6–8",
  "9-12": "Grades 9–12",
};

/** Draws the tutor's page and wires it to its Durable Object. */
export function mountTutor(options: MountTutorOptions): MountedTutor {
  const { gadget, persona } = options;
  const root = options.root ?? document.body;
  const speech = options.speech ?? (globalThis as SpeechHost);
  const speaks = canSpeak(speech);
  const slow = persona.band === "K-2";

  if (!document.getElementById("tutor-styles")) {
    document.head.append(el("style", { id: "tutor-styles", text: TUTOR_STYLES }));
  }

  const conversation = el("ol", { class: "tutor-conversation", "aria-label": "Conversation", "aria-live": "polite" });
  const status = el("p", { class: "tutor-status", role: "status" });
  const input = el("textarea", {
    id: "tutor-message", class: "tutor-input", rows: persona.band === "K-2" ? 2 : 3,
    placeholder: persona.inputPlaceholder, maxlength: 2000, autocomplete: "off",
  });
  const sendButton = el("button", { type: "submit", class: "tutor-send" }, "Send");
  const topicInput = el("input", {
    id: "tutor-topic", class: "tutor-topic-input", type: "text", maxlength: 600,
    placeholder: persona.topicPlaceholder, autocomplete: "off",
  });
  const topicSaved = el("span", { class: "tutor-topic-saved", "aria-live": "polite" });
  const quickButtons = persona.quickReplies.map((text) =>
    el("button", { type: "button", class: "tutor-quick", onclick: () => void send(text) }, text));
  let busy = false;

  const resetButton = el("button", { type: "button", class: "tutor-reset" }, "Start over");
  let resetArmed: ReturnType<typeof setTimeout> | undefined;
  resetButton.addEventListener("click", () => {
    // The sandbox blocks window.confirm, so a second tap within a few seconds confirms.
    if (resetArmed === undefined) {
      resetButton.textContent = "Tap again to start over";
      resetArmed = setTimeout(() => { resetArmed = undefined; resetButton.textContent = "Start over"; }, 4000);
      return;
    }
    clearTimeout(resetArmed);
    resetArmed = undefined;
    resetButton.textContent = "Start over";
    stopSpeaking(speech);
    void gadget.reset().then((state) => { topicInput.value = ""; render(state); }, () => setStatus("Couldn't start over. Try again."));
  });

  function setStatus(text: string): void {
    status.textContent = text;
  }

  function bubble(turn: TutorTurn | { role: "notice"; text: string }): HTMLLIElement {
    const item = el("li", { class: `tutor-turn tutor-turn-${turn.role}` });
    if (turn.role === "tutor") item.append(el("span", { class: "tutor-face", "aria-hidden": "true" }, persona.avatar));
    const body = el("div", { class: "tutor-bubble" });
    body.append(el("span", { class: "sr-only" }, turn.role === "learner" ? "You said: " : turn.role === "tutor" ? `${persona.name} said: ` : "Note: "));
    body.append(el("span", { class: "tutor-text" }, turn.text));
    item.append(body);
    if (turn.role === "tutor" && speaks) {
      item.append(el("button", {
        type: "button", class: "tutor-speak", "aria-label": "Read this aloud", title: "Read this aloud",
        onclick: () => speak(turn.text, { slow }, speech),
      }, "🔊"));
    }
    return item;
  }

  function render(state: TutorState): void {
    conversation.replaceChildren(bubble({ role: "tutor", text: persona.greeting }), ...state.turns.map(bubble));
    if (state.topic !== "" && document.activeElement !== topicInput) topicInput.value = state.topic;
    conversation.lastElementChild?.scrollIntoView?.({ block: "end" });
  }

  function setBusy(value: boolean): void {
    busy = value;
    sendButton.disabled = value;
    for (const button of quickButtons) button.disabled = value;
    root.querySelector(".tutor")?.setAttribute("aria-busy", String(value));
  }

  async function send(text: string): Promise<void> {
    const message = text.trim();
    if (message === "" || busy) return;
    setBusy(true);
    stopSpeaking(speech);
    setStatus(`${persona.name} is thinking…`);
    conversation.append(bubble({ role: "learner", text: message }));
    const thinking = el("li", { class: "tutor-turn tutor-turn-thinking", "aria-hidden": "true" }, [
      el("span", { class: "tutor-face" }, persona.avatar), el("div", { class: "tutor-bubble" }, "…"),
    ]);
    conversation.append(thinking);
    thinking.scrollIntoView?.({ block: "end" });
    try {
      const result = await gadget.ask(message);
      render(result.state);
      if (result.ok) {
        setStatus("");
        if (persona.readAloud) speak(result.reply, { slow }, speech);
      } else {
        conversation.append(bubble({ role: "notice", text: result.message }));
        setStatus(result.message);
        if (input.value.trim() === "" && text !== "") input.value = message;
      }
    } catch {
      thinking.remove();
      const notice = "The tutor can't be reached right now. Check your connection and try again.";
      conversation.append(bubble({ role: "notice", text: notice }));
      setStatus(notice);
    } finally {
      setBusy(false);
    }
  }

  const composer = el("form", { class: "tutor-composer" }, [
    el("label", { for: "tutor-message", class: "sr-only" }, "Your message"),
    input,
    sendButton,
  ]);
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value;
    input.value = "";
    void send(text);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  const topicForm = el("form", { class: "tutor-topic" }, [
    el("label", { for: "tutor-topic" }, persona.topicLabel),
    el("div", { class: "tutor-topic-row" }, [topicInput, el("button", { type: "submit", class: "tutor-topic-save" }, "Save"), topicSaved]),
  ]);
  topicForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const asked = topicInput.value.trim();
    void gadget.setTopic(asked).then((state) => {
      topicInput.value = state.topic;
      // A topic holding contact details or an address is not kept (see TutorSession.setTopic).
      topicSaved.textContent = state.topic !== "" ? "Saved" : asked === "" ? "Cleared" : "Not saved: leave out personal details";
      setTimeout(() => { topicSaved.textContent = ""; }, 4000);
    }, () => setStatus("Couldn't save that. Try again."));
  });

  const page = el("main", { class: "tutor", "data-band": persona.band }, [
    el("header", { class: "tutor-head" }, [
      el("span", { class: "tutor-avatar", "aria-hidden": "true" }, persona.avatar),
      el("div", { class: "tutor-title" }, [
        el("h1", {}, persona.name),
        el("p", { class: "tutor-tagline" }, persona.tagline),
      ]),
      el("span", { class: "tutor-band" }, GRADE_LABELS[persona.band]),
      resetButton,
    ]),
    topicForm,
    conversation,
    status,
    quickButtons.length > 0 ? el("div", { class: "tutor-quick-row", role: "group", "aria-label": "Quick replies" }, quickButtons) : null,
    composer,
    el("p", { class: "tutor-help" }, persona.helpNote),
  ]);
  const { theme } = persona;
  page.style.setProperty("--tutor-accent", theme.accent);
  page.style.setProperty("--tutor-on-accent", theme.onAccent);
  page.style.setProperty("--tutor-background", theme.background);
  page.style.setProperty("--tutor-font-size", `${theme.fontSize}px`);
  root.replaceChildren(page);
  render({ topic: "", turns: [] });

  const loaded = gadget.getState().then(render, () => setStatus("Couldn't load the conversation. Try reloading."));
  return { element: page, send, loaded };
}
