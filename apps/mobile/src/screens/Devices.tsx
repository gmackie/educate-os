import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Laptop, Smartphone } from 'lucide-react-native';
import type { DeviceSummary } from '../types';
import { useAppState } from '../state/app-state';
import { useLoad } from '../hooks/useLoad';
import { usePalette } from '../ui/theme-context';
import { Button, Card, Chip, dateLabel, Item, Placeholder, QueryState } from '../ui/Primitives';

/** Your devices (`/api/m/me/devices`): list, and sign out one phone (this one included). */
export function DevicesSection() {
  const palette = usePalette();
  const router = useRouter();
  const { client, session, signOut } = useAppState();
  const [busy, setBusy] = useState(false);
  const self = session?.credential.kind === 'device' ? session.credential.deviceId : null;
  const [state, reload] = useLoad('devices:' + (self ?? ''), async () => {
    if (!client || !self) throw new Error('Connect this phone to your school to see your devices.');
    return (await client.myDevices()).devices;
  });
  if (!client || !self) {
    return <Placeholder title="Not available" message="Your devices are listed once this phone is connected with a school code."/>;
  }
  const revoke = (device: DeviceSummary) => {
    const isSelf = device.id === self;
    Alert.alert(isSelf ? 'Sign out this phone?' : 'Sign out ' + device.label + '?',
      isSelf ? 'This phone will forget your school.' : 'It will be signed out the next time it connects.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              if (isSelf) { await signOut(); router.replace('/welcome'); return; }
              await client.revokeDevice(device.id);
              reload();
            } catch (e) {
              Alert.alert("Couldn't sign out that device", e instanceof Error ? e.message : 'Try again.');
            } finally { setBusy(false); }
          })();
        } },
      ]);
  };
  return <>
    <QueryState state={state} retry={reload} empty={(list) => list.length === 0}>
      {(list) => <Card>{list.map((device) => <Item key={device.id}
        title={device.label + (device.id === self ? ' (this phone)' : '')}
        detail={[device.model, device.status === 'active' ? 'Last used ' + dateLabel(device.lastSeenAt, true) : 'Signed out'].join(' · ')}
        leading={device.platform === 'web' ? <Laptop size={20} color={palette.primary}/> : <Smartphone size={20} color={palette.primary}/>}
        trailing={device.status === 'active'
          ? <Button label="Sign out" variant="quiet" disabled={busy} onPress={() => revoke(device)}/>
          : <Chip label="Signed out" tone="neutral"/>}/>)}</Card>}
    </QueryState>
    <Text style={{ color: palette.muted, fontSize: 12, lineHeight: 19, marginTop: 14 }}>
      Your school can also sign devices out. A signed-out phone forgets your school the next time it connects.
    </Text>
  </>;
}
