import { useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { School } from 'lucide-react-native';
import { readDirectoryConfig, searchDirectory, type DirectoryEntry } from '../src/directory';
import { usePalette } from '../src/ui/theme-context';
import { Button, Card, Field, Item, Page, Placeholder, Title } from '../src/ui/Primitives';

/** "Find my school" in the optional educateos.io directory (off by default; see src/directory.ts). */
export default function Find() {
  const palette = usePalette();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    if (busy) return;
    setBusy(true);
    try { setResults(await searchDirectory(readDirectoryConfig(Constants.expoConfig?.extra), query)); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };

  if (failed) {
    return <Page>
      <Placeholder title="Search isn't available" message="You can still scan your school's code or enter its web address."/>
      <Button label="I have a web address" variant="outline" onPress={() => router.replace('/address')}/>
    </Page>;
  }
  return <Page>
    <Title subtitle="Search by your school's name or your school email address.">Find my school</Title>
    <Card style={{ gap: 14, marginBottom: 20 }}>
      <Field label="School name or email" value={query} onChangeText={setQuery} placeholder="Northfield, or you@northfield.org"/>
      <Button label={busy ? 'Searching…' : 'Search'} disabled={busy || query.trim().length < 3} onPress={() => { void search(); }}/>
    </Card>
    {results && (results.length === 0
      ? <Text style={{ color: palette.muted }}>No schools matched. Try the web address instead.</Text>
      : <Card>{results.map((entry) => <Item key={entry.origin} title={entry.name} detail={entry.origin}
        leading={<School size={21} color={palette.primary}/>}
        onPress={() => router.replace({ pathname: '/connect', params: { o: entry.origin } })}/>)}</Card>)}
  </Page>;
}
