/** Sets the viewport the shell sees: narrow below 48rem (and no system dark preference), wide at or above it. */
export function setViewport(kind: "narrow" | "wide"): void {
  window.matchMedia = ((query: string) => ({
    matches: kind === "wide" && query.includes("min-width"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
