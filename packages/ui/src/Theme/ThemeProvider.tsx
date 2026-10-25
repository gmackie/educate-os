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
  /** Chooses a mode, records it with the source, and puts it in force. */
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

/**
 * Holds the theme for everything inside it and keeps the document showing it: the mode `source`
 * gives, or the one chosen since, following the system's preference live while that is "system".
 */
export const ThemeProvider = ({ source, children }: { source: ThemeModeSource; children: ReactNode }) => {
  const [themeMode, setChosenMode] = useState(() => source.read());
  const systemMode = useSyncExternalStore(subscribeToSystemThemeMode, systemThemeMode, () => "light" as const);
  const resolvedThemeMode = themeMode === "system" ? systemMode : themeMode;

  // A layout effect, so the first paint already shows the theme rather than flashing light first.
  useLayoutEffect(() => {
    applyThemeMode(resolvedThemeMode);
  }, [resolvedThemeMode]);

  const setThemeMode = (mode: ThemeMode) => {
    source.write(mode);
    setChosenMode(mode);
  };

  return <ThemeContext value={{ themeMode, resolvedThemeMode, setThemeMode }}>{children}</ThemeContext>;
};

/** The theme in force. Needs a `ThemeProvider` above it. */
export const useTheme = (): ThemeState => {
  const theme = use(ThemeContext);
  if (theme === null) throw new Error("useTheme needs a ThemeProvider");
  return theme;
};
