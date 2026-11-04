import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus,
  useAudioRecorder, useAudioRecorderState, type RecordingOptions,
} from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { Mic, Pause, Play, RotateCcw, Square } from 'lucide-react-native';
import { usePalette } from './theme-context';
import { Button } from './Primitives';
import { stopReading } from './ReadAloud';
import { clock, MAX_RECORDING_SECONDS } from '../activity.ts';
import { audioExtension, uploadTypeFor } from '../media.ts';

// Voice recordings for activity steps (SCHO-342). The phone records AAC in an `.m4a` file, which
// the district stores as `audio/mp4`. A recording lives in the app's cache only until it is saved
// or thrown away; nothing the student records is kept on the phone after that.

/** Mono speech at 64 kbit/s: two minutes is about 1 MB, well under the district's 5 MiB limit. */
const VOICE: RecordingOptions = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64000 };

function discard(uri: string | null | undefined): void {
  if (!uri) return;
  try { const file = new File(uri); if (file.exists) file.delete(); } catch { /* the system clears the cache anyway */ }
}

/** Play and pause for one audio file on the phone, with how far along it is. */
export function AudioClip({ uri, label, large = false }: { uri: string; label: string; large?: boolean }) {
  const palette = usePalette();
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);
  useEffect(() => {
    if (status.didJustFinish) void player.seekTo(0);
  }, [status.didJustFinish, player]);
  const toggle = () => {
    if (status.playing) { player.pause(); return; }
    stopReading();
    void setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {}).finally(() => player.play());
  };
  const Icon = status.playing ? Pause : Play;
  return <Pressable accessibilityRole="button" accessibilityLabel={(status.playing ? 'Pause ' : 'Play ') + label}
    onPress={toggle} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: large ? 16 : 12,
      borderRadius: 16, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.raised, opacity: pressed ? 0.75 : 1 })}>
    <View style={{ width: large ? 56 : 40, height: large ? 56 : 40, borderRadius: 28, backgroundColor: palette.primary,
      alignItems: 'center', justifyContent: 'center' }}><Icon size={large ? 28 : 20} color={palette.onPrimary}/></View>
    <View style={{ flex: 1 }}>
      <Text style={{ color: palette.ink, fontWeight: '800', fontSize: large ? 20 : 15 }}>{status.playing ? 'Playing…' : 'Listen'}</Text>
      <Text style={{ color: palette.muted, fontSize: large ? 16 : 12 }}>
        {clock(status.currentTime)} / {status.isLoaded && status.duration > 0 ? clock(status.duration) : '–:––'}</Text>
    </View>
  </Pressable>;
}

/**
 * Saved or submitted audio, given as base64: written to a cache file for the player, and removed
 * when the screen goes away.
 */
export function Base64Audio({ base64, label, large = false }: { base64: string; label: string; large?: boolean }) {
  const palette = usePalette();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let file: File | null = null;
    let live = true;
    void (async () => {
      try {
        file = new File(Paths.cache, 'eos-audio-' + Date.now().toString(36) + Math.random().toString(36).slice(2) + audioExtension(base64));
        await file.write(base64, { encoding: 'base64' });
        if (live) setUri(file.uri);
      } catch { if (live) setFailed(true); }
    })();
    return () => { live = false; discard(file?.uri); };
  }, [base64]);
  if (failed) return <Text style={{ color: palette.muted }}>This recording could not be opened on this phone.</Text>;
  if (!uri) return <Text style={{ color: palette.muted }}>Opening the recording…</Text>;
  return <AudioClip uri={uri} label={label} large={large}/>;
}

type Phase = { kind: 'idle' } | { kind: 'starting' } | { kind: 'recording' } | { kind: 'recorded'; uri: string };

/**
 * Record, listen back, then save, as the web's recorder does: up to two minutes, stopping itself at
 * the limit. `onRecorded` saves the recording and resolves true once it is saved.
 */
export function VoiceRecorder({ stepTitle, disabled = false, large = false, onRecorded }: {
  stepTitle: string; disabled?: boolean; large?: boolean;
  onRecorded: (file: { base64: string; mediaType: 'audio/mp4' }) => Promise<boolean>;
}) {
  const palette = usePalette();
  const recorder = useAudioRecorder(VOICE);
  const state = useAudioRecorderState(recorder, 250);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = useRef<Phase>(phase);
  current.current = phase;

  const finish = async () => {
    if (current.current.kind !== 'recording') return;
    current.current = { kind: 'starting' };
    try { await recorder.stop(); } catch { /* already stopped at the limit */ }
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    const uri = recorder.uri;
    setPhase(uri ? { kind: 'recorded', uri } : { kind: 'idle' });
    if (!uri) setError('The recording could not be kept. Try again.');
  };

  // The recorder stops itself at the limit (`forDuration`); this notices, and stops it if it didn't.
  useEffect(() => {
    if (phase.kind !== 'recording') return;
    if ((!state.isRecording && state.durationMillis > 0) || state.durationMillis >= MAX_RECORDING_SECONDS * 1000) void finish();
  }, [phase.kind, state.isRecording, state.durationMillis]);

  // Leaving the screen stops a recording and throws away anything not saved.
  useEffect(() => () => {
    const last = current.current;
    if (last.kind === 'recording') void recorder.stop().catch(() => {});
    if (last.kind === 'recorded') discard(last.uri);
  }, [recorder]);

  const start = async () => {
    setError(null);
    stopReading();
    setPhase({ kind: 'starting' });
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setPhase({ kind: 'idle' });
        setError(permission.canAskAgain ? 'EducateOS needs the microphone to record you.' : 'Allow the microphone for EducateOS in Settings to record.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record({ forDuration: MAX_RECORDING_SECONDS });
      setPhase({ kind: 'recording' });
    } catch {
      setPhase({ kind: 'idle' });
      setError('Recording could not start. Close other apps using the microphone and try again.');
    }
  };
  const again = () => {
    if (phase.kind === 'recorded') discard(phase.uri);
    setPhase({ kind: 'idle' });
  };
  const save = async () => {
    if (phase.kind !== 'recorded') return;
    setSaving(true); setError(null);
    try {
      const base64 = await new File(phase.uri).base64();
      if (uploadTypeFor('recording', base64) !== 'audio/mp4') {
        setError('This recording is too long or could not be read. Record a shorter one.');
        return;
      }
      if (await onRecorded({ base64, mediaType: 'audio/mp4' })) { discard(phase.uri); setPhase({ kind: 'idle' }); }
    } catch { setError('The recording could not be read. Record it again.'); } finally { setSaving(false); }
  };

  const seconds = Math.floor(state.durationMillis / 1000);
  const big = { fontSize: large ? 22 : 15 };
  return <View style={{ gap: 12 }}>
    {phase.kind === 'recording' ? <>
      <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: palette.red }}/>
        <Text style={[{ color: palette.ink, fontWeight: '800' }, big]}>Recording {clock(seconds)}</Text>
        <Text style={{ color: palette.muted }}>of {clock(MAX_RECORDING_SECONDS)}</Text>
      </View>
      <RecordButton large={large} label="Stop" icon={<Square size={large ? 30 : 20} color={palette.onPrimary}/>}
        onPress={() => { void finish(); }} accessibilityLabel={'Stop recording ' + stepTitle} danger/>
    </> : phase.kind === 'recorded' ? <>
      <Text style={[{ color: palette.ink, fontWeight: '700' }, big]}>Listen to your recording, then save it.</Text>
      <AudioClip uri={phase.uri} label={'your recording for ' + stepTitle} large={large}/>
      <Button label={saving ? 'Saving…' : 'Save my recording'} disabled={saving || disabled} onPress={() => { void save(); }}/>
      <Button label="Record again" variant="quiet" disabled={saving} icon={<RotateCcw size={17} color={palette.primary}/>} onPress={again}/>
    </> : <RecordButton large={large} label={phase.kind === 'starting' ? 'Starting…' : 'Record'} disabled={disabled || phase.kind === 'starting'}
      icon={<Mic size={large ? 30 : 20} color={palette.onPrimary}/>} onPress={() => { void start(); }}
      accessibilityLabel={'Record your voice for ' + stepTitle}/>}
    {error && <Text accessibilityRole="alert" style={{ color: palette.red, lineHeight: 20 }}>{error}</Text>}
    {phase.kind === 'idle' && <Text style={{ color: palette.muted, fontSize: large ? 16 : 12 }}>Up to {MAX_RECORDING_SECONDS / 60} minutes.</Text>}
  </View>;
}

function RecordButton({ label, icon, onPress, disabled = false, large, danger = false, accessibilityLabel }: {
  label: string; icon: React.ReactNode; onPress: () => void; disabled?: boolean; large: boolean; danger?: boolean; accessibilityLabel: string;
}) {
  const palette = usePalette();
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12,
      minHeight: large ? 72 : 52, borderRadius: large ? 36 : 26, backgroundColor: danger ? palette.red : palette.primary,
      opacity: disabled ? 0.45 : pressed ? 0.75 : 1 })}>
    {icon}<Text style={{ color: palette.onPrimary, fontWeight: '800', fontSize: large ? 24 : 16 }}>{label}</Text>
  </Pressable>;
}
