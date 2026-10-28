// Light and dark palettes for the native screens (SCHO-262). The mode follows the system
// (useColorScheme) unless the person overrides it under Me, and the AI workspace WebView is told the
// same mode, so the app never mixes light and dark. A school's accent (from its manifest) replaces
// the primary colour. React bindings live in ui/theme-context.tsx; this module stays pure.

export type ColorMode = 'light' | 'dark';
export type ThemePreference = 'system' | ColorMode;

export type Palette = {
  background: string; surface: string; raised: string; ink: string;
  muted: string; subtle: string; line: string;
  primary: string; primarySoft: string; onPrimary: string;
  teal: string; tealSoft: string; amber: string; amberSoft: string;
  red: string; redSoft: string; navy: string; shadow: string;
};

export const lightPalette: Palette = {
  background: '#F6F8FC', surface: '#FFFFFF', raised: '#FFFFFF', ink: '#17233E',
  muted: '#63718A', subtle: '#8490A3', line: '#E5EAF2',
  primary: '#265DE3', primarySoft: '#EBF1FF', onPrimary: '#FFFFFF',
  teal: '#118A83', tealSoft: '#E5F6F3', amber: '#B46D1C', amberSoft: '#FFF3DC',
  red: '#BD3D47', redSoft: '#FFF0F0', navy: '#142750', shadow: '#9DAAC0',
};

export const darkPalette: Palette = {
  background: '#0D1320', surface: '#151D2D', raised: '#1B2438', ink: '#E7ECF6',
  muted: '#A2ADC1', subtle: '#7C879B', line: '#27324A',
  primary: '#7FA3FF', primarySoft: '#1C2A4D', onPrimary: '#0B1222',
  teal: '#43C4BA', tealSoft: '#12302E', amber: '#F0A954', amberSoft: '#382811',
  red: '#F27D86', redSoft: '#3B1B20', navy: '#1A2B55', shadow: '#000000',
};

export const spacing = { xs: 4, sm: 8, md: 12, base: 16, lg: 20, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 16, lg: 22, xl: 28 } as const;
export const font = { caption: 12, body: 15, secondary: 13, subtitle: 17, heading: 24, hero: 31 } as const;

export function resolveMode(preference: ThemePreference, system: string | null | undefined): ColorMode {
  if (preference === 'light' || preference === 'dark') return preference;
  return system === 'dark' ? 'dark' : 'light';
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** `a` moved toward `b` by `amount` (0..1). */
export function mix(a: string, b: string, amount: number): string {
  const x = rgb(a), y = rgb(b);
  return hex([x[0] + (y[0] - x[0]) * amount, x[1] + (y[1] - x[1]) * amount, x[2] + (y[2] - x[2]) * amount]);
}
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The palette for a mode, with a school's accent as the primary colour when it has one. */
export function paletteFor(mode: ColorMode, accent?: string | null): Palette {
  const base = mode === 'dark' ? darkPalette : lightPalette;
  if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent)) return base;
  // Keep the accent readable on the background: lighten it on dark, darken it on light, as needed.
  let primary = accent.toUpperCase();
  for (let i = 0; i < 8 && contrast(primary, base.background) < 4.5; i++) {
    primary = mix(primary, mode === 'dark' ? '#FFFFFF' : '#000000', 0.15);
  }
  const onPrimary = contrast('#FFFFFF', primary) >= contrast('#0B1222', primary) ? '#FFFFFF' : '#0B1222';
  const primarySoft = mix(primary, base.surface, mode === 'dark' ? 0.78 : 0.9);
  return { ...base, primary, primarySoft, onPrimary };
}

/**
 * Tells the web app the native colour mode (and school accent) the way its own theme code reads it:
 * `data-mode` and `color-scheme` on <html>, and the stored preference keys, so the AI workspace never
 * disagrees with the native screens. Safe to run again whenever the mode changes.
 */
export function themeScript(mode: ColorMode, accent?: string | null): string {
  const m = JSON.stringify(mode);
  return 'try{["educateos:theme-mode","gadgets:theme-mode"].forEach(function(k){localStorage.setItem(k,' + m + ');});}catch(e){}' +
    'var root=document.documentElement;root.setAttribute("data-mode",' + m + ');root.style.colorScheme=' + m + ';' +
    (accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? 'root.style.setProperty("--educateos-accent",' + JSON.stringify(accent) + ');' : '') +
    'try{window.dispatchEvent(new CustomEvent("educateos:theme-mode",{detail:' + m + '}));}catch(e){}';
}
