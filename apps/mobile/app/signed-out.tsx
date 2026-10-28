import { Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShieldOff } from 'lucide-react-native';
import { useAppState } from '../src/state/app-state';
import { usePalette } from '../src/ui/theme-context';
import { Button, Page } from '../src/ui/Primitives';

/** Shown when the school revokes this phone (device-revoked or refresh-token-reused). */
export default function SignedOut() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { revoked, dismissRevoked } = useAppState();
  if (!revoked) return <Redirect href="/"/>;
  return <View style={{ flex: 1, backgroundColor: palette.background, paddingTop: insets.top }}><Page>
    <View style={{ alignItems: 'center', gap: 16, paddingTop: 50 }}>
      <View style={{ backgroundColor: palette.amberSoft, padding: 22, borderRadius: 25 }}>
        <ShieldOff size={38} color={palette.amber}/>
      </View>
      <Text accessibilityRole="header" style={{ fontSize: 23, color: palette.ink, fontWeight: '800', textAlign: 'center' }}>
        This phone was signed out by your school
      </Text>
      <Text style={{ fontSize: 14, textAlign: 'center', lineHeight: 22, color: palette.muted }}>
        {revoked.name} signed this phone out, or it was signed out from Your devices. Its school information has been removed from this phone.
      </Text>
    </View>
    <View style={{ gap: 11, marginTop: 30 }}>
      <Button label="Connect again" onPress={() => {
        const origin = revoked.origin;
        dismissRevoked();
        router.replace({ pathname: '/connect', params: { o: origin } });
      }}/>
      <Button label="Choose a school" variant="outline" onPress={() => { dismissRevoked(); router.replace('/welcome'); }}/>
    </View>
  </Page></View>;
}
