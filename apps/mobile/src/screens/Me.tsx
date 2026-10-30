import { useEffect, useState } from 'react';
import { Alert, Pressable, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, Building2, CalendarDays, KeyRound, LogOut, ScanFace, ShieldCheck, Trash2, UserRound } from 'lucide-react-native';
import type { ThemePreference } from '../theme';
import { useAppState } from '../state/app-state';
import { CalendarFeed, EmailSettings, SignOutEverywhere } from './MeSettings';
import { enablePush, pushOptedIn, setPushOptOut } from '../push';
import { biometricsAvailable, useAppLock } from '../lock';
import { useTheme } from '../ui/theme-context';
import { Button, Card, Chip, Item, Page, Section, Title } from '../ui/Primitives';
import { DevicesSection } from './Devices';

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' },
];

function ThemePicker() {
  const { palette, preference, setPreference } = useTheme();
  return <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', backgroundColor: palette.background,
    borderRadius: 14, padding: 4, gap: 4 }}>
    {THEMES.map(({ id, label }) => <Pressable key={id} accessibilityRole="radio" accessibilityState={{ selected: preference === id }}
      onPress={() => setPreference(id)} style={{ flex: 1, paddingVertical: 10, borderRadius: 11, alignItems: 'center',
        backgroundColor: preference === id ? palette.raised : 'transparent' }}>
      <Text style={{ color: preference === id ? palette.primary : palette.muted, fontWeight: '700' }}>{label}</Text>
    </Pressable>)}
  </View>;
}

/** Me: profile, devices, theme, notifications, switch school, sign out, delete account. */
export function Me() {
  const { palette } = useTheme();
  const router = useRouter();
  const { session, principal, client, signOut, role } = useAppState();
  const lock = useAppLock();
  const [push, setPush] = useState(false);
  const [faceId, setFaceId] = useState(false);
  useEffect(() => {
    void pushOptedIn().then(setPush);
    void biometricsAvailable().then(setFaceId);
  }, []);
  if (!session) return null;
  const device = session.credential.kind === 'device';

  return <Page>
    <Title>Me</Title>
    <View style={{ alignItems: 'center', gap: 9, marginBottom: 28 }}>
      <View style={{ width: 72, height: 72, borderRadius: 24, backgroundColor: palette.primarySoft,
        alignItems: 'center', justifyContent: 'center' }}>
        {principal?.displayName
          ? <Text style={{ fontSize: 26, fontWeight: '800', color: palette.primary }}>{initials(principal.displayName)}</Text>
          : <UserRound size={34} color={palette.primary}/>}
      </View>
      <Text style={{ fontWeight: '800', fontSize: 23, color: palette.ink }}>{principal?.displayName ?? 'Your school account'}</Text>
      <Chip label={principal?.kind === 'staff' ? 'Staff' : principal?.kind === 'guardian' ? 'Family' :
        principal?.kind === 'student' ? 'Student' : 'School workspace'} tone="green"/>
    </View>

    <Section title="School"><Card>
      <Item title={session.district.name} detail={session.district.origin} leading={<Building2 size={21} color={palette.primary}/>}/>
      <Item title="Signed in with" detail={device ? 'This phone, connected by your school'
        : session.credential.kind === 'cloudflare-access' ? 'Cloudflare Access, school-managed' : 'Workshop session, school-managed'}
        leading={<KeyRound size={21} color={palette.primary}/>}/>
      {principal?.kind !== 'guardian' && <Item title="Calendar" detail="Deadlines, announcements and term dates"
        leading={<CalendarDays size={21} color={palette.primary}/>} onPress={() => router.push('/calendar')}/>}
    </Card>
      {client?.available && principal?.kind !== 'guardian' && <CalendarFeed client={client} origin={session.district.origin}/>}
    </Section>

    {device && <Section title="Your devices"><DevicesSection/>
      {client && <SignOutEverywhere client={client} onDone={() => { void signOut().then(() => router.replace('/welcome')); }}/>}
    </Section>}

    <Section title="Appearance"><Card><ThemePicker/></Card></Section>

    {client?.available && principal && <EmailSettings client={client} role={role}/>}

    <Section title="Notifications and security"><Card>
      <Item title="Notifications" detail="Due work and messages. Never grades or names."
        leading={<Bell size={21} color={palette.teal}/>}
        trailing={<Switch value={push} accessibilityLabel="Notifications" onValueChange={(on) => {
          if (on) void enablePush(client).then((result) => setPush(result !== 'denied' && result !== 'unsupported'));
          else { setPush(false); void setPushOptOut(); }
        }}/>}/>
      {faceId && <Item title="Lock with Face ID" detail="Ask for Face ID when EducateOS opens."
        leading={<ScanFace size={21} color={palette.teal}/>}
        trailing={<Switch value={lock.enabled} accessibilityLabel="Lock with Face ID"
          onValueChange={(on) => { void lock.setEnabled(on); }}/>}/>}
      <Item title="Your school controls your data" detail="Class content, grades and AI policies stay with your school."
        leading={<ShieldCheck size={21} color={palette.teal}/>}/>
    </Card></Section>

    <View style={{ gap: 10, marginBottom: 24 }}>
      <Button label="Switch school" variant="outline" onPress={() => router.push('/welcome')}/>
      <Button label="Sign out of this school" variant="danger" icon={<LogOut color={palette.red} size={19}/>}
        onPress={() => Alert.alert('Sign out?', 'This phone will forget its sign-in for ' + session.district.name + '.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign out', style: 'destructive', onPress: () => { void signOut().then(() => router.replace('/welcome')); } },
        ])}/>
      <Button label="Delete account" variant="quiet" icon={<Trash2 color={palette.primary} size={18}/>}
        onPress={() => router.push('/delete-account')}/>
    </View>
    <Text style={{ textAlign: 'center', fontSize: 12, color: palette.subtle }}>
      EducateOS is open source. No central EducateOS student account is created.
    </Text>
  </Page>;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words.at(-1)![0] : '')).toUpperCase();
}
