/**
 * The tutor page's stylesheet, injected once by `mountTutor` (a gadget carries its CSS in the module
 * that injects it). Sizes follow the persona's base font size, so the youngest readers get big text
 * and big buttons; the accent and background come from the persona too. Printing shows the
 * conversation alone, for a learner who wants to hand it in.
 */
export const TUTOR_STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--tutor-background, #f7f7fb); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.tutor {
  --tutor-ink: #1d1d27;
  --tutor-muted: #565668;
  font: var(--tutor-font-size, 17px)/1.5 ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif;
  color: var(--tutor-ink);
  background: var(--tutor-background, #f7f7fb);
  max-width: 46em;
  min-height: 100vh;
  margin: 0 auto;
  padding: 1em 1em 1.5em;
  display: flex;
  flex-direction: column;
  gap: 0.8em;
}
.tutor button { font: inherit; cursor: pointer; border-radius: 0.8em; border: 2px solid transparent; }
.tutor button:focus-visible, .tutor input:focus-visible, .tutor textarea:focus-visible { outline: 3px solid var(--tutor-accent); outline-offset: 2px; }
.tutor button:disabled { opacity: 0.55; cursor: progress; }
.tutor-head { display: flex; align-items: center; gap: 0.7em; flex-wrap: wrap; }
.tutor-avatar { font-size: 2.4em; line-height: 1; }
.tutor-title { flex: 1; min-width: 10em; }
.tutor-title h1 { font-size: 1.4em; margin: 0; line-height: 1.2; }
.tutor-tagline { margin: 0.1em 0 0; color: var(--tutor-muted); font-size: 0.9em; }
.tutor-band { font-size: 0.75em; font-weight: 600; padding: 0.3em 0.7em; border-radius: 999px; background: #fff; border: 1px solid #d9d9e3; }
.tutor-reset { background: #fff; border-color: #d9d9e3 !important; padding: 0.4em 0.8em; font-size: 0.85em !important; }
.tutor-topic { display: flex; flex-direction: column; gap: 0.3em; background: #fff; border: 1px solid #e3e3ec; border-radius: 1em; padding: 0.7em 0.9em; }
.tutor-topic label { font-weight: 600; font-size: 0.9em; }
.tutor-topic-row { display: flex; gap: 0.5em; align-items: center; flex-wrap: wrap; }
.tutor-topic-input { flex: 1; min-width: 12em; font: inherit; font-size: 0.95em; padding: 0.45em 0.7em; border: 1px solid #cfcfdb; border-radius: 0.6em; }
.tutor-topic-save { background: #fff; border-color: var(--tutor-accent) !important; color: var(--tutor-ink); padding: 0.4em 0.9em; }
.tutor-topic-saved { font-size: 0.8em; color: var(--tutor-muted); }
.tutor-conversation { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.7em; flex: 1; }
.tutor-turn { display: flex; align-items: flex-end; gap: 0.5em; max-width: 92%; }
.tutor-turn-learner { align-self: flex-end; flex-direction: row-reverse; }
.tutor-face { font-size: 1.6em; line-height: 1; }
.tutor-bubble { padding: 0.6em 0.9em; border-radius: 1.1em; white-space: pre-wrap; overflow-wrap: anywhere; }
.tutor-turn-tutor .tutor-bubble, .tutor-turn-thinking .tutor-bubble { background: #fff; border: 2px solid var(--tutor-accent); border-bottom-left-radius: 0.3em; }
.tutor-turn-learner .tutor-bubble { background: var(--tutor-accent); color: var(--tutor-on-accent); border-bottom-right-radius: 0.3em; }
.tutor-turn-notice { align-self: center; max-width: 100%; }
.tutor-turn-notice .tutor-bubble { background: #fff7e0; border: 1px solid #e8c766; font-size: 0.9em; }
.tutor-turn-thinking .tutor-bubble { letter-spacing: 0.2em; animation: tutor-pulse 1.2s ease-in-out infinite; }
@keyframes tutor-pulse { 50% { opacity: 0.4; } }
.tutor-speak { background: #fff; border-color: #d9d9e3 !important; min-width: 2.6em; min-height: 2.6em; padding: 0; }
.tutor-status { margin: 0; min-height: 1.2em; font-size: 0.85em; color: var(--tutor-muted); }
.tutor-quick-row { display: flex; flex-wrap: wrap; gap: 0.5em; }
.tutor-quick { background: #fff; border-color: var(--tutor-accent) !important; color: var(--tutor-ink); padding: 0.5em 1em; }
.tutor-composer { display: flex; gap: 0.5em; align-items: stretch; }
.tutor-input { flex: 1; font: inherit; padding: 0.6em 0.8em; border: 2px solid #cfcfdb; border-radius: 1em; resize: vertical; background: #fff; }
.tutor-send { background: var(--tutor-accent); color: var(--tutor-on-accent); font-weight: 700; padding: 0 1.3em; }
.tutor-help { margin: 0; font-size: 0.8em; color: var(--tutor-muted); text-align: center; }
/* The youngest readers: huge targets, one obvious thing to press. */
.tutor[data-band="K-2"] .tutor-send, .tutor[data-band="K-2"] .tutor-quick { min-height: 2.8em; min-width: 5em; font-weight: 700; }
.tutor[data-band="K-2"] .tutor-quick { flex: 1 1 40%; }
.tutor[data-band="K-2"] .tutor-speak { min-width: 3em; min-height: 3em; font-size: 1.1em; }
@media (prefers-reduced-motion: reduce) { .tutor-turn-thinking .tutor-bubble { animation: none; } }
@media print {
  body, .tutor { background: #fff; }
  .tutor { min-height: 0; max-width: none; }
  .tutor-reset, .tutor-topic-row button, .tutor-topic-saved, .tutor-speak, .tutor-quick-row, .tutor-composer, .tutor-status, .tutor-turn-thinking { display: none !important; }
  .tutor-topic { border: none; padding: 0; }
  .tutor-topic-input { border: none; padding: 0; }
  .tutor-turn { max-width: 100%; break-inside: avoid; }
  .tutor-bubble { border: 1px solid #999 !important; background: #fff !important; color: #000 !important; }
}
`;
