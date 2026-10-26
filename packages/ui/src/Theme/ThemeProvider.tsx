import { createContext, use, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  applyThemeMode,
  subscribeToSystemThemeMode,
  systemThemeMode,
  type ResolvedThemeMode,
  type ThemeMode,
  type ThemeModeSource,
} from "./themeMode";

/** The theme in force, and how to change it. */
export interface ThemeState {
  /** What the person chose. */
  themeMode: ThemeMode;
  /** What is showing: `themeMode`, with "system" resolved against the system's current preference. */
  resolvedThemeMode: ResolvedThemeMode;
  /**
   * Chooses a mode, records it with the source, and puts it in force. Absent where a host decides
   * the theme, so there is nothing to choose.
   */
  setThemeMode?: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

const noSubscription = () => () => {};

/**
 * Holds the theme for everything inside it and keeps the document showing it: the mode `source`
 * gives, or the one chosen since, following the system's preference live while that is "system".
 * A host source is followed as it changes, and nothing here can override it.
 */
export const ThemeProvider = ({ source, children }: { source: ThemeModeSource; children: ReactNode }) => {
  const [chosenMode, setChosenMode] = useState(() => source.read());
  const hostMode = useSyncExternalStore("subscribe" in source ? source.subscribe : noSubscription, () => source.read());
  const systemMode = useSyncExternalStore(subscribeToSystemThemeMode, systemThemeMode, () => "light" as const);
  const themeMode = "subscribe" in source ? hostMode : chosenMode;
  const resolvedThemeMode = themeMode === "system" ? systemMode : themeMode;

  // A layout effect, so the first paint already shows the theme rather than flashing light first.
  useLayoutEffect(() => {
    applyThemeMode(resolvedThemeMode);
  }, [resolvedThemeMode]);

  const setThemeMode = "write" in source
    ? (mode: ThemeMode) => {
        source.write(mode);
        setChosenMode(mode);
      }
    : undefined;

  return <ThemeContext value={{ themeMode, resolvedThemeMode, setThemeMode }}>{children}</ThemeContext>;
};

/** The theme in force. Needs a `ThemeProvider` above it. */
export const useTheme = (): ThemeState => {
  const theme = use(ThemeContext);
  if (theme === null) throw new Error("useTheme needs a ThemeProvider");
  return theme;
};
