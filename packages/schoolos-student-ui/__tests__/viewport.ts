/** Sets the viewport the layout sees: a phone below 48rem, a desktop at or above it. */
export function setViewport(kind: "phone" | "desktop"): void {
  window.matchMedia = ((query: string) => ({
    matches: kind === "desktop" && query.includes("min-width"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
