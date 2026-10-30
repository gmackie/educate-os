import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { lightPalette, paletteFor, resolveMode, type ColorMode, type Palette, type ThemePreference } from '../theme';

const KEY = 'educateos.theme.v1';

type ThemeValue = {
  mode: ColorMode; palette: Palette; preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeValue>({
  mode: 'light', palette: lightPalette, preference: 'system', setPreference: () => {},
});

export function ThemeProvider({ accent, children }: { accent?: string | null; children: React.ReactNode }) {
  const system = useColorScheme();
  const [preference, setStored] = useState<ThemePreference>('system');
  useEffect(() => {
    void AsyncStorage.getItem(KEY).then((value) => {
      if (value === 'light' || value === 'dark' || value === 'system') setStored(value);
    }).catch(() => {});
  }, []);
  const setPreference = useCallback((next: ThemePreference) => {
    setStored(next);
    void AsyncStorage.setItem(KEY, next).catch(() => {});
  }, []);
  const mode = resolveMode(preference, system);
  const value = useMemo(() => ({ mode, palette: paletteFor(mode, accent), preference, setPreference }),
    [mode, accent, preference, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue { return useContext(ThemeContext); }
export function usePalette(): Palette { return useContext(ThemeContext).palette; }
