import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bell, ScanFace } from 'lucide-react-native';
import { useAppState } from '../src/state/app-state';
import { enablePush, type PushResult } from '../src/push';
import { biometricsAvailable, useAppLock } from '../src/lock';
import { usePalette } from '../src/ui/theme-context';
import { Button, Page, Title } from '../src/ui/Primitives';

const PUSH_MESSAGE: Record<PushResult, string> = {
  enabled: 'Notifications are on.',
  denied: 'Notifications are off. You can turn them on later in Settings.',
  unsupported: "This device can't receive notifications.",
  'school-unsupported': "Notifications are on. Your school will start sending them when it's ready.",
};

/** Storyboard 4: both prompts are optional; nothing is asked until the person chooses. */
export default function Permissions() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { client } = useAppState();
  const lock = useAppLock();
  const [push, setPush] = useState<PushResult | null>(null);
  const [faceId, setFaceId] = useState(false);
  const [lockMessage, setLockMessage] = useState<string | null>(null);
  useEffect(() => { void biometricsAvailable().then(setFaceId); }, []);

  return <View style={{ flex: 1, backgroundColor: palette.background, paddingTop: insets.top }}><Page>
    <View style={{ alignItems: 'center', paddingVertical: 20 }}><Bell size={44} color={palette.primary}/></View>
    <Title subtitle="Notifications for due work and messages. They never include grades or names.">Stay in the loop</Title>
    <View style={{ gap: 12 }}>
      <Button label={push ? 'Notifications chosen' : 'Allow notifications'} disabled={!!push}
        onPress={() => { void enablePush(client).then(setPush); }}/>
      {push && <Text style={{ color: palette.muted }}>{PUSH_MESSAGE[push]}</Text>}
      {faceId && <Button label={lock.enabled ? 'Face ID lock is on' : 'Lock with Face ID'} variant="outline" disabled={lock.enabled}
        icon={<ScanFace size={18} color={palette.primary}/>}
        onPress={() => { void lock.setEnabled(true).then((on) => setLockMessage(on ? null : 'Face ID lock was not turned on.')); }}/>}
      {lockMessage && <Text style={{ color: palette.muted }}>{lockMessage}</Text>}
      <Button label={push || lock.enabled ? 'Continue' : 'Not now'} variant="quiet" onPress={() => router.replace('/')}/>
    </View>
  </Page></View>;
}
