import { Button, Tooltip } from "@cloudflare/kumo";
import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTheme } from "./ThemeProvider";
import { systemThemeMode, type ResolvedThemeMode, type ThemeMode } from "./themeMode";

const NEXT_MODE: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };

const ICONS: Record<ThemeMode, typeof SunIcon> = { system: DesktopIcon, light: SunIcon, dark: MoonIcon };

const describe = (mode: ThemeMode, resolved: ResolvedThemeMode) => (mode === "system" ? `Theme: system (${resolved})` : `Theme: ${mode}`);

/**
 * The theme control the Workshop's sidebar has: one button that steps through system, light and
 * dark, named for the mode in force and the one it switches to. `onAnnounce` receives the new mode
 * to say, so it reaches the app's own live region rather than a second one. Where a host decides
 * the theme there is nothing to choose, and the button is not shown.
 */
export const ThemeModeButton = ({ onAnnounce }: { onAnnounce: (message: string) => void }) => {
  const { themeMode, resolvedThemeMode, setThemeMode } = useTheme();
  if (setThemeMode === undefined) return null;
  const nextMode = NEXT_MODE[themeMode];
  const label = `${describe(themeMode, resolvedThemeMode)}. Switch to ${nextMode}.`;
  const Icon = ICONS[themeMode];
  return (
    <Tooltip
      content={label}
      render={(
        <Button
          variant="ghost"
          shape="square"
          aria-label={label}
          icon={<Icon aria-hidden size={18} />}
          onClick={() => {
            setThemeMode(nextMode);
            onAnnounce(describe(nextMode, nextMode === "system" ? systemThemeMode() : nextMode));
          }}
        />
      )}
    />
  );
};
