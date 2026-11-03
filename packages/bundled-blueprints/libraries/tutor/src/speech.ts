/**
 * Reading a reply aloud with the browser's own speech synthesis. Nothing leaves the device. Where the
 * sandboxed iframe has no `speechSynthesis`, every function here does nothing and the page hides its
 * read-aloud buttons.
 */

/** The part of `window` speech needs, so a test can hand in its own. */
export interface SpeechHost {
  speechSynthesis?: Pick<SpeechSynthesis, "speak" | "cancel">;
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
}

/** Whether `host` can read aloud. */
export function canSpeak(host: SpeechHost = globalThis as SpeechHost): boolean {
  return host.speechSynthesis !== undefined && host.SpeechSynthesisUtterance !== undefined;
}

/**
 * Reads `text` aloud, a little slower than usual for `slow` (young) listeners, after stopping
 * whatever was being read. Emoji are skipped, since a voice would read their names.
 */
export function speak(text: string, options: { slow?: boolean } = {}, host: SpeechHost = globalThis as SpeechHost): void {
  if (!canSpeak(host)) return;
  const spoken = text.replaceAll(/\p{Extended_Pictographic}/gu, "").trim();
  if (spoken === "") return;
  host.speechSynthesis!.cancel();
  const utterance = new host.SpeechSynthesisUtterance!(spoken);
  utterance.rate = options.slow ? 0.85 : 1;
  host.speechSynthesis!.speak(utterance);
}

/** Stops reading aloud. */
export function stopSpeaking(host: SpeechHost = globalThis as SpeechHost): void {
  if (canSpeak(host)) host.speechSynthesis!.cancel();
}
