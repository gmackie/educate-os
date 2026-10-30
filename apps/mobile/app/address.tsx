import { useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { fetchSchoolManifest } from '../src/manifest';
import { normalizeAddress } from '../src/security';
import { usePalette } from '../src/ui/theme-context';
import { Button, Card, Field, Page, Title } from '../src/ui/Primitives';

/** One web address, checked against the school's `/.well-known/educateos.json`. */
export default function Address() {
  const palette = usePalette();
  const router = useRouter();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const origin = normalizeAddress(value);
      const manifest = await fetchSchoolManifest(origin);
      router.replace({ pathname: '/connect', params: { o: manifest.origin } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That address could not be checked.');
    } finally { setBusy(false); }
  };

  return <Page>
    <Title subtitle="The address you use for your school's website, such as northfield.educateos.io.">Your school's web address</Title>
    <Card style={{ gap: 14 }}>
      <Field label="School web address" value={value} onChangeText={setValue} keyboardType="url"
        placeholder="https://yourschool.educateos.io"/>
      {error && <Text accessibilityRole="alert" style={{ color: palette.red, lineHeight: 20 }}>{error}</Text>}
      <Button label={busy ? 'Checking…' : 'Continue'} disabled={busy || value.trim().length < 4} onPress={() => { void check(); }}/>
    </Card>
  </Page>;
}
