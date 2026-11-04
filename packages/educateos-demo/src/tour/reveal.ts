// Scrolls a tour step's point of interest into view once its screen shows it (SCHO-328): the apps
// open at the top of the page, and on a long activity the tutor or the feedback is far below.

/** How long to wait for the element before giving up, so a screen that never shows it costs nothing. */
const GIVE_UP_MS = 15_000;

/**
 * Scrolls the first element matching `selector` into view once the page is at `route` and shows
 * one. Checking starts on the next task, so the screen being left, which may hold a match of its
 * own, is gone by then. Returns a function that stops waiting.
 */
export function revealWhenShown(selector: string, route: string, root: ParentNode & Node = document.body): () => void {
  let observer: MutationObserver | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(start);
    clearTimeout(giveUp);
    observer?.disconnect();
  };
  const reveal = () => {
    if (window.location.hash !== route) return false;
    const element = root.querySelector(selector);
    if (element === null) return false;
    element.scrollIntoView?.({ block: "start", behavior: "smooth" });
    return true;
  };
  const start = setTimeout(() => {
    if (reveal()) return;
    observer = new MutationObserver(() => {
      if (reveal()) stop();
    });
    observer.observe(root, { childList: true, subtree: true });
    giveUp = setTimeout(stop, GIVE_UP_MS);
  }, 0);
  return stop;
}
