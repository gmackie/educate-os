import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { CheckCircle2, GraduationCap, LockKeyhole, Plus, School, Trash2 } from 'lucide-react-native';
import type { District } from '../types';
import { makeDistrict } from '../district';
import { palette } from '../theme';
import { Button, Card, Eyebrow, Field, Item, Page, Title } from '../ui/Primitives';

export function Onboarding({ computerPairing, enrollment, districts, busy, error, onAdd, onConnect, onRemove }: {
  computerPairing?: { school: { name: string; portal: string; workshop: string }; code: string | null; onConnect: () => void; onCancel: () => void };
  enrollment?: { name: string; portal: string; workshop: string } | null;
  districts: District[]; busy: boolean; error?: string | null;
  onAdd: (district: District) => Promise<void>;
  onConnect: (district: District) => Promise<void>;
  onRemove: (district: District) => void;
}) {
  const [name, setName] = useState(enrollment?.name || '');
  const [portal, setPortal] = useState(enrollment?.portal || '');
  const [workshop, setWorkshop] = useState(enrollment?.workshop || '');
  const [adding, setAdding] = useState(Boolean(enrollment) || districts.length === 0);
  const [formError, setFormError] = useState<string | null>(null);
  const save = async () => {
    setFormError(null);
    try {
      const district = makeDistrict(name, portal, workshop || portal);
      await onAdd(district);
      setAdding(false);
      setName(''); setPortal(''); setWorkshop('');
    } catch (e) { setFormError(e instanceof Error ? e.message : 'Invalid school address.'); }
  };
  return <Page>
    <View style={{ alignItems: 'center', paddingTop: 18, paddingBottom: 16 }}>
      <View style={{ width: 64, height: 64, borderRadius: 22, backgroundColor: palette.primary,
        alignItems: 'center', justifyContent: 'center' }}><GraduationCap size={36} color={palette.white}/></View>
    </View>
    <Eyebrow>Welcome to EducateOS</Eyebrow>
    <Title subtitle="One app for school, learning, and your AI workspace. Your school keeps control of its data.">
      Your school. Your space.
    </Title>
    {error && <Text accessibilityRole="alert" style={{ color: palette.red, marginBottom: 14 }}>{error}</Text>}
    {computerPairing && <Card style={{ gap: 12, marginBottom: 20 }}>
      <Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800' }}>Connect from your computer</Text>
      <Text style={{ color: palette.ink }}>{computerPairing.school.name}</Text>
      <Text style={{ color: palette.muted }}>School: {computerPairing.school.portal}</Text>
      <Text style={{ color: palette.muted }}>Workspace: {computerPairing.school.workshop}</Text>
      {computerPairing.code ? <>
        <Text style={{ color: palette.ink, fontSize: 30, fontWeight: '800', textAlign: 'center' }}>{computerPairing.code}</Text>
        <Text style={{ color: palette.muted }}>Check that this code matches your computer, then approve in the signed-in Workshop. Only continue if you started this connection.</Text>
      </> : <Button label="Connect this phone" disabled={busy} onPress={computerPairing.onConnect}/>}
      <Button label="Cancel computer pairing" variant="quiet" onPress={computerPairing.onCancel}/>
    </Card>}
    {!computerPairing && districts.length > 0 && <View style={{ gap: 8, marginBottom: 20 }}>
      <Text style={{ color: palette.ink, fontWeight: '800', fontSize: 17, marginBottom: 6 }}>Your schools</Text>
      {districts.map((district) => <Card key={district.id}>
        <Item title={district.name} detail={district.portal} leading={<School size={22} color={palette.primary}/>}
          onPress={() => { void onConnect(district); }}/>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 9 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={'Remove ' + district.name}
            onPress={() => Alert.alert('Remove this school?', 'You can add it again later.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Remove', style: 'destructive', onPress: () => onRemove(district) },
            ])} style={{ padding: 8, flexDirection: 'row', gap: 5, alignItems: 'center' }}>
            <Trash2 size={15} color={palette.red}/><Text style={{ color: palette.red }}>Remove</Text>
          </Pressable>
        </View>
      </Card>)}
    </View>}
    {!computerPairing && (adding ? <Card style={{ gap: 15, marginBottom: 20 }}>
      <Text style={{ color: palette.ink, fontSize: 17, fontWeight: '800' }}>Add your school</Text>
      <Text style={{ color: palette.muted, lineHeight: 21 }}>Scan your school’s setup QR code with your phone’s Camera app to fill these details. Check the school addresses before saving.</Text>
      <Field label="School or district name" value={name} onChangeText={setName} placeholder="Example: Northfield Schools"/>
      <Field label="School portal URL" value={portal} onChangeText={setPortal} keyboardType="url" placeholder="https://learn.school.example"/>
      <Field label="AI workspace URL" value={workshop} onChangeText={setWorkshop} keyboardType="url"
        placeholder="https://os.school.example (or leave blank)"/>
      {formError && <Text accessibilityRole="alert" style={{ color: palette.red }}>{formError}</Text>}
      <Button label="Save school" disabled={busy} onPress={() => { void save(); }}/>
      {districts.length > 0 && <Button label="Cancel" variant="quiet" onPress={() => setAdding(false)}/>}
    </Card> : <Button label="Add another school" variant="outline" onPress={() => setAdding(true)}
      icon={<Plus size={18} color={palette.primary}/>}/>)}
    {busy && !computerPairing && <Text style={{ color: palette.muted, textAlign: 'center', padding: 10 }}>Opening your school's secure sign-in…</Text>}
    <View style={{ paddingTop: 30, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <LockKeyhole size={17} color={palette.teal}/>
        <Text style={{ color: palette.ink, fontWeight: '700' }}>School-owned and private</Text>
      </View>
      <Text style={{ color: palette.muted, lineHeight: 21, fontSize: 13 }}>
        EducateOS doesn't create a central student account. You'll sign in with the district's identity provider,
        and your school decides which features you can use.
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <CheckCircle2 size={16} color={palette.teal}/><Text style={{ color: palette.muted, fontSize: 13 }}>Secure, installation-specific sessions</Text>
      </View>
    </View>
  </Page>;
}
