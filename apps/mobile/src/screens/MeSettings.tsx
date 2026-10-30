import { useState } from 'react';
import { Alert, Linking, Switch, Text, View } from 'react-native';
import { CalendarPlus, Mail } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { EmailPreferences, Role } from '../types';
import { useLoad } from '../hooks/useLoad';
import { usePalette } from '../ui/theme-context';
import { Button, Card, Item, Section } from '../ui/Primitives';

const EMAIL_KINDS: { key: keyof EmailPreferences['email']; label: string; detail: string; roles: Role[] }[] = [
  { key: 'assignments', label: 'New assignments', detail: 'When work is posted or a due date moves', roles: ['student'] },
  { key: 'announcements', label: 'Announcements', detail: 'Messages from teachers', roles: ['student', 'teacher', 'guardian'] },
  { key: 'feedback', label: 'Feedback', detail: 'When a teacher shares comments', roles: ['student'] },
  { key: 'grades', label: 'Grades', detail: 'When a grade becomes official', roles: ['student'] },
  { key: 'digest', label: 'Weekly family digest', detail: "Your children's week, every weekend", roles: ['guardian'] },
];

/** Which school emails this person gets. The school decides whether email is sent at all. */
export function EmailSettings({ client, role }: { client: DistrictClient; role: Role }) {
  const palette = usePalette();
  const [state, reload] = useLoad('preferences', () => client.preferences());
  const [prefs, setPrefs] = useState<EmailPreferences | null>(null);
  const current = prefs ?? (state.status === 'ready' ? state.value : null);
  if (!current || !current.hasEmailAddress) return null;
  const kinds = EMAIL_KINDS.filter((k) => k.roles.includes(role));
  if (kinds.length === 0) return null;
  const toggle = (key: keyof EmailPreferences['email'], on: boolean) => {
    setPrefs({ ...current, email: { ...current.email, [key]: on } });
    client.updatePreferences({ [key]: on }).then(setPrefs, (e: unknown) => {
      setPrefs(null); reload();
      Alert.alert("Couldn't save", e instanceof Error ? e.message : 'Try again.');
    });
  };
  return <Section title="Email"><Card>
    {!current.emailEnabled && <Text style={{ color: palette.muted, lineHeight: 20, paddingVertical: 8 }}>
      Your school hasn't turned on email yet. Your choices apply once it does.</Text>}
    {kinds.map((kind) => <Item key={kind.key} title={kind.label} detail={kind.detail}
      leading={<Mail size={20} color={palette.teal}/>}
      trailing={<Switch value={current.email[kind.key]} accessibilityLabel={kind.label + ' email'}
        onValueChange={(on) => toggle(kind.key, on)}/>}/>)}
  </Card></Section>;
}

/**
 * A private calendar feed of due dates and school events, subscribed to in the phone's Calendar.
 * The address is a secret: it is shown to Calendar once and never stored here.
 */
export function CalendarFeed({ client, origin }: { client: DistrictClient; origin: string }) {
  const palette = usePalette();
  const [state, reload] = useLoad('calendar-feed', () => client.calendarFeed());
  const [busy, setBusy] = useState(false);
  const subscribe = () => {
    setBusy(true);
    client.rotateCalendarFeed().then(async ({ path }) => {
      const url = new URL(path, origin);
      // webcal:// asks Calendar to subscribe; it fetches over the school's own scheme.
      await Linking.openURL('webcal://' + url.host + url.pathname + url.search);
      reload();
    }).catch((e: unknown) => Alert.alert("Couldn't add the calendar", e instanceof Error ? e.message : 'Try again.'))
      .finally(() => setBusy(false));
  };
  const stop = () => Alert.alert('Turn off the calendar feed?', 'Calendars subscribed to it stop updating.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Turn off', style: 'destructive', onPress: () => { client.revokeCalendarFeed().then(reload, () => {}); } },
  ]);
  if (state.status !== 'ready') return null;
  return <Card style={{ gap: 12, marginTop: 12 }}>
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <CalendarPlus size={21} color={palette.primary}/>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: palette.ink, fontWeight: '800' }}>Add to your calendar</Text>
        <Text style={{ color: palette.muted, fontSize: 13, lineHeight: 19 }}>{state.value.active
          ? 'Your private calendar link is on. Subscribing again makes a new link and stops the old one.'
          : 'See due dates and school events in your phone’s Calendar.'}</Text>
      </View>
    </View>
    <Button label={busy ? 'Opening Calendar…' : state.value.active ? 'Subscribe again' : 'Subscribe in Calendar'}
      variant="outline" disabled={busy} onPress={subscribe}/>
    {state.value.active && <Button label="Turn off the feed" variant="quiet" onPress={stop}/>}
  </Card>;
}

/** Signs every phone and browser connection to this school out, this one included. */
export function SignOutEverywhere({ client, onDone }: { client: DistrictClient; onDone: () => void }) {
  return <Button label="Sign out on all devices" variant="quiet" onPress={() => Alert.alert('Sign out everywhere?',
    'Every phone connected to your account is signed out, this one too. Connect again with a new code.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out everywhere', style: 'destructive', onPress: () => {
        client.revokeAllDevices().then(onDone, (e: unknown) => Alert.alert("Couldn't sign out", e instanceof Error ? e.message : 'Try again.'));
      } },
    ])}/>;
}
