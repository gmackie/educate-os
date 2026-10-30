// The Workshop's theme: light, dark or system, through @gadgets/ui/theme (its ThemeProvider and
// ThemeModeButton), the one theme system every EducateOS surface uses (SCHO-260). The Workshop keeps
// only two things of its own:
//
// - its palettes, as Kumo token overrides in styles.css (the near-neutral light one, and the
//   violet-tinted dark one under `[data-mode="dark"]`), and
// - the accent override: a deployment may set the accent family at runtime from an admin-chosen
//   seed colour. Hover, lighter and selection shades are derived from the seed with CSS
//   relative-colour syntax (`oklch(from <seed> ...)`), so the admin picks one colour. The shared
//   applicator validates the seed before interpolating it into CSS values.
//
// Where the choice is kept depends on the origin. On a district origin, where the Workshop is the
// AI workspace under `/ai/` beside the LMS, it shares the LMS's key, so one choice applies
// everywhere at once. At the root of its own origin it keeps the key it always had.

import type { ThemeMode, ThemeModeSource } from '@gadgets/ui/theme'
import { applyAccentColor as applyAccentColorToStyle } from '@gadgets/workshop-shared/theme'
import { isDistrictOrigin } from './workshopBase'

/** The key the Workshop has always kept its choice under, and still does at an origin's root. */
export const LEGACY_THEME_STORAGE_KEY = 'gadgets:theme-mode'

/** The key every surface on a district origin shares (`EDUCATEOS_THEME_STORAGE_KEY` in @educateos/shell). */
export const DISTRICT_THEME_STORAGE_KEY = 'educateos:theme-mode'

const isThemeMode = (value: string | null): value is ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system'

/** Where the choice is kept for a Workshop mounted at `base`: `/` keeps the legacy key. */
export function themeStorageKey(base: string): string {
  return isDistrictOrigin(base) ? DISTRICT_THEME_STORAGE_KEY : LEGACY_THEME_STORAGE_KEY
}

const readKey = (storage: Storage, key: string): string | null => {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Carries a choice made under the legacy key over to the district key, once: only when the
 * district key holds no choice yet, and the legacy one is removed so it is never read again.
 * Storage that is unavailable leaves things as they are.
 */
export function migrateLegacyThemeMode(storage: Storage): void {
  if (isThemeMode(readKey(storage, DISTRICT_THEME_STORAGE_KEY))) return
  const legacy = readKey(storage, LEGACY_THEME_STORAGE_KEY)
  if (legacy === null) return
  try {
    if (isThemeMode(legacy)) storage.setItem(DISTRICT_THEME_STORAGE_KEY, legacy)
    storage.removeItem(LEGACY_THEME_STORAGE_KEY)
  } catch {
    // Read again on the next load.
  }
}

/**
 * The mode a host put on <html> before the app started (the phone app's WebView sets `data-mode`
 * to match the phone), if any. Read before anything else touches the attribute.
 */
export function injectedThemeMode(root: HTMLElement): 'light' | 'dark' | undefined {
  const mode = root.getAttribute('data-mode')
  return mode === 'light' || mode === 'dark' ? mode : undefined
}

/**
 * The Workshop's theme source, made once as the app starts. Its choice is kept under
 * `themeStorageKey(base)`, migrating the legacy key on a district origin. Where nothing has been
 * chosen yet, a mode the host injected is adopted (not stored, so the host's mode keeps applying
 * until the person picks one), and otherwise it is "system".
 */
export function workshopThemeSource(
  base: string,
  root: HTMLElement = document.documentElement,
  storage: Storage | undefined = safeLocalStorage(),
): ThemeModeSource {
  const injected = injectedThemeMode(root)
  const key = themeStorageKey(base)
  if (storage !== undefined && key !== LEGACY_THEME_STORAGE_KEY) migrateLegacyThemeMode(storage)
  return {
    read: () => {
      const stored = storage === undefined ? null : readKey(storage, key)
      return isThemeMode(stored) ? stored : injected ?? 'system'
    },
    write: (mode) => {
      try {
        storage?.setItem(key, mode)
      } catch {
        // The mode still applies until the page is left.
      }
    },
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/** Apply the accent color to the document root. Pass "" / invalid to clear back to the base theme. */
export function applyAccentColor(color: string | null | undefined): void {
  applyAccentColorToStyle(document.documentElement.style, color)
}

/** The base/default accent, shown in the admin picker when no custom color is set. */
export const DEFAULT_ACCENT_COLOR = '#ff4801'
