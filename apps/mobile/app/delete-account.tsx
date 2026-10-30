import { Alert, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Building2, Trash2 } from 'lucide-react-native';
import { useAppState } from '../src/state/app-state';
import { usePalette } from '../src/ui/theme-context';
import { Button, Card, Page, Title } from '../src/ui/Primitives';

/**
 * App Store guideline 5.1.1(v). EducateOS never creates accounts: the school (district) creates and
 * owns them, so only the school can delete one. This screen says so plainly, sends the person to
 * the school's site, and deletes everything this app holds for the school.
 */
export default function DeleteAccount() {
  const palette = usePalette();
  const router = useRouter();
  const { session, removeSchool } = useAppState();
  if (!session) return null;
  const school = session.district;
  return <Page>
    <Title subtitle="Your school account belongs to your school.">Delete your account</Title>
    <Card style={{ gap: 12, marginBottom: 18 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Building2 size={20} color={palette.primary}/>
        <Text style={{ color: palette.ink, fontWeight: '800', fontSize: 16, flex: 1 }}>{school.name} manages your account</Text>
      </View>
      <Text style={{ color: palette.muted, lineHeight: 21 }}>
        EducateOS doesn't create accounts. Your school created your account and keeps your school records, so
        only your school can delete them. Ask your school's office or administrator to delete your account;
        its privacy policy explains what it keeps and for how long.
      </Text>
      <Button label={"Open " + new URL(school.origin).host} variant="outline"
        onPress={() => { void WebBrowser.openBrowserAsync(school.origin + '/'); }}/>
    </Card>
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Trash2 size={20} color={palette.red}/>
        <Text style={{ color: palette.ink, fontWeight: '800', fontSize: 16 }}>Remove everything from this phone</Text>
      </View>
      <Text style={{ color: palette.muted, lineHeight: 21 }}>
        Signs this phone out with your school and deletes its key, sign-in and saved school details from this phone now.
      </Text>
      <Button label="Remove this school from this phone" variant="danger" onPress={() => Alert.alert(
        'Remove this school?', 'This phone will be signed out and its data for ' + school.name + ' deleted.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: () => { void removeSchool(school).then(() => router.replace('/welcome')); } },
        ])}/>
    </Card>
  </Page>;
}
