// Scrolls a tour step's point of interest into view once its screen shows it (SCHO-328): the apps
// open at the top of the page, and on a long activity the tutor or the feedback is far below.
// The rest of the page may still be rendering after the element appears (SCHO-327: the tutor and
// "My work" above the feedback pushed it two screens down mid-scroll), so the scroll follows the
// element, and scrolls again as the page grows, until it settles or the visitor scrolls for themselves.

/** How long to wait for the element before giving up, so a screen that never shows it costs nothing. */
const GIVE_UP_MS = 15_000;

/** How long the page must go without moving the element before the scroll stops following it. */
const SETTLE_MS = 800;

/** Input that means the visitor is scrolling themselves, which the tour must not fight. */
const VISITOR_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * Scrolls the first element matching `selector` into view once the page is at `route` and shows
 * one, and scrolls to it again if the page moves it before settling. Checking starts on the next
 * task, so the screen being left, which may hold a match of its own, is gone by then. Returns a
 * function that stops waiting.
 */
export function revealWhenShown(selector: string, route: string, root: ParentNode & Node = document.body): () => void {
  let observer: MutationObserver | undefined;
  let resized: ResizeObserver | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let target: Element | undefined;
  let targetTop = 0;
  const stop = () => {
    clearTimeout(start);
    clearTimeout(giveUp);
    clearTimeout(settle);
    observer?.disconnect();
    resized?.disconnect();
    for (const type of VISITOR_SCROLL_EVENTS) window.removeEventListener(type, stop, true);
  };
  // Where the element will sit once a scroll reaches it, measured against the document.
  const documentTop = (element: Element) => element.getBoundingClientRect().top + window.scrollY;
  const restartSettle = () => {
    clearTimeout(settle);
    settle = setTimeout(stop, SETTLE_MS);
  };
  const check = () => {
    if (window.location.hash !== route) return;
    if (target === undefined) {
      const element = root.querySelector(selector);
      if (element === null) return;
      target = element;
      targetTop = documentTop(element);
      element.scrollIntoView?.({ block: "start", behavior: "smooth" });
      for (const type of VISITOR_SCROLL_EVENTS) window.addEventListener(type, stop, { capture: true, passive: true });
      restartSettle();
      return;
    }
    if (!target.isConnected) return;
    const top = documentTop(target);
    const moved = Math.abs(top - targetTop) >= 1;
    // A page too short to bring it to the top stops the scroll early; content arriving below it
    // makes room without moving it.
    const room = target.getBoundingClientRect().top > 1
      && window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 1;
    if (!moved && !room) return;
    // Follow, without restarting a smooth scroll from where it is now.
    targetTop = top;
    target.scrollIntoView?.({ block: "start", behavior: "auto" });
    restartSettle();
  };
  const start = setTimeout(() => {
    check();
    observer = new MutationObserver(check);
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    // An image or font arriving moves the element without changing the DOM.
    if (typeof ResizeObserver !== "undefined" && root instanceof Element) {
      resized = new ResizeObserver(check);
      resized.observe(root);
    }
    giveUp = setTimeout(stop, GIVE_UP_MS);
  }, 0);
  return stop;
}
