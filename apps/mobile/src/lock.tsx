// Optional Face ID / biometric lock. Off unless the person turns it on; asked again after the app
// has been in the background for five minutes.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { LockKeyhole } from 'lucide-react-native';
import { usePalette } from './ui/theme-context';
import { Button } from './ui/Primitives';

const KEY = 'educateos.app-lock.v1';
const RELOCK_AFTER_MS = 5 * 60_000;

export async function biometricsAvailable(): Promise<boolean> {
  try { return await LocalAuthentication.hasHardwareAsync() && await LocalAuthentication.isEnrolledAsync(); }
  catch { return false; }
}

type Lock = { enabled: boolean; setEnabled: (on: boolean) => Promise<boolean> };
const LockContext = createContext<Lock>({ enabled: false, setEnabled: async () => false });
export function useAppLock(): Lock { return useContext(LockContext); }

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const palette = usePalette();
  const [enabled, setStored] = useState(false);
  const [locked, setLocked] = useState(true);
  const [ready, setReady] = useState(false);
  const backgroundAt = useRef<number | null>(null);

  useEffect(() => {
    void AsyncStorage.getItem(KEY).then((value) => {
      const on = value === 'on';
      setStored(on); setLocked(on); setReady(true);
    }).catch(() => { setLocked(false); setReady(true); });
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') backgroundAt.current = Date.now();
      if (state === 'active' && enabled && backgroundAt.current && Date.now() - backgroundAt.current > RELOCK_AFTER_MS) setLocked(true);
    });
    return () => subscription.remove();
  }, [enabled]);

  const unlock = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock EducateOS' }).catch(() => null);
    if (result?.success) setLocked(false);
  }, []);
  useEffect(() => { if (ready && locked && enabled) void unlock(); }, [ready, locked, enabled, unlock]);

  const setEnabled = useCallback(async (on: boolean) => {
    if (on) {
      if (!await biometricsAvailable()) return false;
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Turn on Face ID lock' }).catch(() => null);
      if (!result?.success) return false;
    }
    await AsyncStorage.setItem(KEY, on ? 'on' : 'off');
    setStored(on);
    return true;
  }, []);

  // The app stays mounted under the lock (navigation and links keep their state); it is only covered.
  return <LockContext.Provider value={{ enabled, setEnabled }}>
    {children}
    {(!ready || (enabled && locked)) && <View accessibilityViewIsModal style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: palette.background, justifyContent: 'center', padding: 28, gap: 18 }}>
      {ready && <>
        <View style={{ alignItems: 'center', gap: 12 }}>
          <LockKeyhole size={40} color={palette.primary}/>
          <Text style={{ color: palette.ink, fontSize: 22, fontWeight: '800' }}>EducateOS is locked</Text>
        </View>
        <Button label="Unlock" onPress={() => { void unlock(); }}/>
      </>}
    </View>}
  </LockContext.Provider>;
}
