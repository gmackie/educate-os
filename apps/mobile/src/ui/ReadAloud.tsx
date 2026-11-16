import { useEffect, useSyncExternalStore } from 'react';
import { Pressable, Text } from 'react-native';
import * as Speech from 'expo-speech';
import { Square, Volume2 } from 'lucide-react-native';
import { usePalette } from './theme-context';

// Read-aloud over the phone's own speech synthesis (SCHO-342), as the web reads with the browser's
// (SCHO-323). One thing is read at a time across the app, so what is being read is a small store
// every "Read to me" control watches. Nothing leaves the phone.

let reading: string | null = null;
const listeners = new Set<() => void>();
const set = (id: string | null) => { reading = id; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Stops anything being read. */
export function stopReading(): void {
  if (reading !== null) set(null);
  void Speech.stop();
}

/** Reads `text` for the control `id`, stopping anything else; a little slower than default, for young listeners. */
export function readAloud(id: string, text: string): void {
  // Cleared first, so the stopped utterance's own callback finds nothing of its own to clear.
  set(null);
  void Speech.stop();
  const finished = () => { if (reading === id) set(null); };
  set(id);
  Speech.speak(text, { rate: 0.9, onDone: finished, onStopped: finished, onError: finished });
}

/** Whether the control `id` is reading now. */
export function useReading(id: string): boolean {
  return useSyncExternalStore(subscribe, () => reading === id);
}

/** Stops reading when the screen goes away. */
export function useStopReadingOnLeave(): void {
  useEffect(() => stopReading, []);
}

/**
 * "Read to me": reads `text` aloud, or stops it. `prominent` is the young-learner size: a big,
 * full-width button beside large type.
 */
export function ReadAloudButton({ id, text, label, prominent = false }: { id: string; text: string; label: string; prominent?: boolean }) {
  const palette = usePalette();
  const on = useReading(id);
  const Icon = on ? Square : Volume2;
  return <Pressable accessibilityRole="button" accessibilityLabel={(on ? 'Stop reading ' : 'Read to me: ') + label}
    accessibilityState={{ selected: on }} onPress={() => on ? stopReading() : readAloud(id, text)} hitSlop={8}
    style={({ pressed }) => ({
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: prominent ? 12 : 6, alignSelf: prominent ? 'stretch' : 'flex-start',
      minHeight: prominent ? 64 : 36, paddingHorizontal: prominent ? 20 : 12, borderRadius: prominent ? 20 : 18,
      backgroundColor: on ? palette.primary : palette.primarySoft, opacity: pressed ? 0.75 : 1,
    })}>
    <Icon size={prominent ? 30 : 17} color={on ? palette.onPrimary : palette.primary}/>
    <Text style={{ color: on ? palette.onPrimary : palette.primary, fontWeight: '800', fontSize: prominent ? 22 : 14 }}>
      {on ? 'Stop' : 'Read to me'}</Text>
  </Pressable>;
}
