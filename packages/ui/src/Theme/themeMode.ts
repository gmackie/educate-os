// Light, dark and system colour themes, switched the way Kumo expects: `data-mode` on <html>, which
// selects its dark tokens, and `color-scheme`, which its `light-dark()` tokens and native controls
// read. The Workshop applies its own theme the same way (workshop-frontend/src/theme.ts).

/** The theme a person chooses: a fixed one, or whatever their system prefers. */
export type ThemeMode = "light" | "dark" | "system";

/** The theme in force once "system" has been resolved against the system preference. */
export type ResolvedThemeMode = "light" | "dark";

/**
 * Where an app's theme choice comes from and goes to. An app picks its source where it starts, so
 * a host that sets the theme itself (an app embedded in the Workshop, say) can supply one without
 * the theme control or the screens changing.
 */
export type ThemeModeSource =
  | {
      /** The mode to start in. */
      read(): ThemeMode;
      /** Records a mode the person chose. */
      write(mode: ThemeMode): void;
    }
  | {
      /** The mode the host has in force. */
      read(): ResolvedThemeMode;
      /**
       * Calls `onChange` whenever the host's mode changes, until the returned function is called.
       * The host decides the theme, so the app offers no choice of its own.
       */
      subscribe(onChange: () => void): () => void;
    };

const isThemeMode = (value: string | null): value is ThemeMode => value === "light" || value === "dark" || value === "system";

/**
 * A source that keeps the choice in this origin's local storage under `key`, starting from
 * "system". Storage that is unavailable or full leaves the choice in force for this page only.
 */
export const storedThemeMode = (key: string): ThemeModeSource => ({
  read: () => {
    try {
      const stored = window.localStorage.getItem(key);
      return isThemeMode(stored) ? stored : "system";
    } catch {
      return "system";
    }
  },
  write: (mode) => {
    try {
      window.localStorage.setItem(key, mode);
    } catch {
      // The mode still applies until the page is left.
    }
  },
});

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The system's preferred theme; light where the browser cannot say. */
export const systemThemeMode = (): ResolvedThemeMode =>
  typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";

/** Calls `onChange` whenever the system's preferred theme changes, until the returned function is called. */
export const subscribeToSystemThemeMode = (onChange: () => void): (() => void) => {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/** Puts `mode` in force on the document, for Kumo's tokens and the browser's own controls. */
export const applyThemeMode = (mode: ResolvedThemeMode, root: HTMLElement = document.documentElement): void => {
  root.setAttribute("data-mode", mode);
  root.style.colorScheme = mode;
};
