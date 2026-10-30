import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CheckCircle2, Globe, LockKeyhole, QrCode, School, Search, Trash2 } from 'lucide-react-native';
import type { District } from '../src/types';
import { useAppState } from '../src/state/app-state';
import { directoryVisible, readDirectoryConfig } from '../src/directory';
import { usePalette } from '../src/ui/theme-context';
import { Button, Card, Eyebrow, Item, Mark, Page, Title } from '../src/ui/Primitives';

/** Storyboard 1: three ways in, plus the schools this phone already knows. */
export default function Welcome() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { districts, session, openSchool, removeSchool } = useAppState();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const directory = directoryVisible(readDirectoryConfig(Constants.expoConfig?.extra));

  const open = async (district: District) => {
    if (busy) return;
    setBusy(district.id); setError(null);
    try {
      if (await openSchool(district)) router.replace('/');
      else router.push({ pathname: '/connect', params: { o: district.origin } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in could not be completed.');
    } finally { setBusy(null); }
  };

  return <View style={{ flex: 1, backgroundColor: palette.background, paddingTop: insets.top }}><Page>
    <View style={{ alignItems: 'center', paddingTop: 18, paddingBottom: 16 }}>
      <View style={{ width: 64, height: 64, borderRadius: 22, backgroundColor: palette.primary,
        alignItems: 'center', justifyContent: 'center' }}><Mark size={38} color={palette.onPrimary}/></View>
    </View>
    <Eyebrow>Welcome to EducateOS</Eyebrow>
    <Title subtitle="Your school's classes, calendar and AI workspace.">Your school. Your space.</Title>
    {error && <Text accessibilityRole="alert" style={{ color: palette.red, marginBottom: 14 }}>{error}</Text>}

    <View style={{ gap: 11, marginBottom: 26 }}>
      <Button label="Scan school code" onPress={() => router.push('/scan')} icon={<QrCode size={19} color={palette.onPrimary}/>}/>
      {directory && <Button label="Find my school" variant="outline" onPress={() => router.push('/find')}
        icon={<Search size={18} color={palette.primary}/>}/>}
      <Button label="I have a web address" variant="outline" onPress={() => router.push('/address')}
        icon={<Globe size={18} color={palette.primary}/>}/>
      <Text style={{ color: palette.muted, fontSize: 13, lineHeight: 20 }}>
        On a computer, open your school site and choose Connect phone. Then scan the code it shows.
      </Text>
    </View>

    {districts.length > 0 && <View style={{ gap: 8, marginBottom: 20 }}>
      <Text accessibilityRole="header" style={{ color: palette.ink, fontWeight: '800', fontSize: 17, marginBottom: 6 }}>Your schools</Text>
      {districts.map((district) => <Card key={district.id}>
        <Item title={district.name} detail={busy === district.id ? 'Opening…' : district.origin}
          leading={<School size={22} color={palette.primary}/>} onPress={() => { void open(district); }}/>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 9 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={'Remove ' + district.name}
            onPress={() => Alert.alert('Remove this school?', 'This phone will forget the school and sign out of it. You can add it again later.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Remove', style: 'destructive', onPress: () => { void removeSchool(district); } },
            ])} style={{ padding: 8, flexDirection: 'row', gap: 5, alignItems: 'center' }}>
            <Trash2 size={15} color={palette.red}/><Text style={{ color: palette.red }}>Remove</Text>
          </Pressable>
        </View>
      </Card>)}
    </View>}
    {session && <Button label="Back to current school" variant="quiet" onPress={() => router.replace('/')}/>}

    <View style={{ paddingTop: 30, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <LockKeyhole size={17} color={palette.teal}/>
        <Text style={{ color: palette.ink, fontWeight: '700' }}>School-owned and private</Text>
      </View>
      <Text style={{ color: palette.muted, lineHeight: 21, fontSize: 13 }}>
        EducateOS doesn't create a central student account. Your school decides which features you can use,
        and can sign this phone out at any time.
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <CheckCircle2 size={16} color={palette.teal}/><Text style={{ color: palette.muted, fontSize: 13 }}>A key that never leaves this phone</Text>
      </View>
    </View>
  </Page></View>;
}
