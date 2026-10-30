// The one theme for every surface on a district origin: @gadgets/ui/theme's provider and control,
// one storage key, and the school's accent from its manifest.

import { useLayoutEffect } from "react";
import { storedThemeMode, type ThemeModeSource } from "@gadgets/ui/theme";
import { applyAccentColor } from "@gadgets/workshop-shared/theme";

/**
 * Where every surface on the origin (the Learning Home, Teacher Studio, the admin console and the
 * AI workspace) keeps the theme a person chose. One key on one origin, so a choice made in one
 * applies in all of them.
 */
export const EDUCATEOS_THEME_STORAGE_KEY = "educateos:theme-mode";

/** The theme source every EducateOS surface starts its `ThemeProvider` from. */
export const educateosThemeMode = (): ThemeModeSource => storedThemeMode(EDUCATEOS_THEME_STORAGE_KEY);

/**
 * Puts the school's accent in force on the document while the caller is mounted: Kumo's brand,
 * link and selection tokens are derived from it for both light and dark. An absent or malformed
 * accent leaves Kumo's own palette.
 */
export const useBrandAccent = (accent: string | undefined, root?: HTMLElement): void => {
  useLayoutEffect(() => {
    const style = (root ?? document.documentElement).style;
    applyAccentColor(style, accent);
    return () => applyAccentColor(style, null);
  }, [accent, root]);
};
