import { Alert, Text, View } from 'react-native';
import { Bell, Building2, GraduationCap, KeyRound, LogOut, ShieldCheck, Users } from 'lucide-react-native';
import type { Principal, Session } from '../types';
import { palette } from '../theme';
import { Button, Card, Chip, Item, Page, Section, Title } from '../ui/Primitives';

export function Account({ session, me, onSwitch, onSignOut }: {
  session: Session; me: Principal | null; onSwitch: () => void; onSignOut: () => Promise<void>;
}) {
  return <Page>
    <Title subtitle="Your school, identity, and privacy settings.">Account</Title>
    <View style={{ alignItems: 'center', gap: 9, marginBottom: 28 }}>
      <View style={{ width: 72, height: 72, borderRadius: 24, backgroundColor: palette.primarySoft,
        alignItems: 'center', justifyContent: 'center' }}>
        <GraduationCap size={34} color={palette.primary}/>
      </View>
      <Text style={{ fontWeight: '800', fontSize: 23, color: palette.ink }}>
        {me?.displayName ?? 'Your school account'}
      </Text>
      <Chip label={me?.kind === 'staff' ? 'Staff' : me?.kind === 'guardian' ? 'Family' :
        me?.kind === 'student' ? 'Student' : 'School workspace'} tone="green"/>
    </View>
    <Section title="Connected school"><Card>
      <Item title={session.district.name} detail={session.district.portal}
        leading={<Building2 size={21} color={palette.primary}/>}/>
      <Item title="AI workspace" detail={session.district.workshop}
        leading={<GraduationCap size={21} color={palette.primary}/>}/>
      <Item title="Signed-in identity" detail={session.credential.kind === 'cloudflare-access'
        ? 'Cloudflare Access, school-managed' : 'Workshop session, school-managed'}
        leading={<KeyRound size={21} color={palette.primary}/>}/>
    </Card></Section>
    <Section title="Privacy and security"><Card>
      <Item title="Your school controls your data"
        detail="Class content, grades, and AI policies stay with the school's deployment."
        leading={<ShieldCheck size={21} color={palette.teal}/>}/>
      <Item title="Notifications"
        detail="School updates are displayed only after the device is authenticated."
        leading={<Bell size={21} color={palette.teal}/>}/>
      <Item title="Access"
        detail="Your teachers, administrators, and guardians see only what district policies allow."
        leading={<Users size={21} color={palette.teal}/>}/>
    </Card></Section>
    <View style={{ gap: 10, marginBottom: 30 }}>
      <Button label="Switch school" variant="outline" onPress={onSwitch}/>
      <Button label="Sign out from this school" variant="danger" icon={<LogOut color={palette.red} size={19}/>}
        onPress={() => Alert.alert('Sign out?', 'The device will forget this school session.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign out', style: 'destructive', onPress: () => { void onSignOut(); } },
        ])}/>
    </View>
    <Text style={{ textAlign: 'center', fontSize: 12, color: palette.subtle }}>
      EducateOS is open source. No central EducateOS student account is created.
    </Text>
  </Page>;
}
