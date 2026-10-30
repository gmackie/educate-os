import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { onPendingLink, takePendingLink, type LegacyPairing } from '../src/links';
import { legacyDistrict } from '../src/schools';
import { signInFromComputer } from '../src/auth/auth';
import { prepareWebView } from '../src/auth/session';
import { useAppState } from '../src/state/app-state';
import { usePalette } from '../src/ui/theme-context';
import { Button, Card, Page, Placeholder } from '../src/ui/Primitives';

/**
 * SCHO-256 computer pairing (`/pair-phone` QR codes from the Workshop), kept while schools move to
 * the district's own relay (`/j` codes, connect.tsx). Ported from the old onboarding card.
 */
export default function LegacyPair() {
  const palette = usePalette();
  const router = useRouter();
  const { activate } = useAppState();
  const [pairing, setPairing] = useState<LegacyPairing | null>(() => {
    const link = takePendingLink();
    return link?.kind === 'legacy-pair' ? link.pairing : null;
  });
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  // A new code opened while this screen is up replaces the old attempt.
  useEffect(() => onPendingLink((link) => {
    if (link.kind !== 'legacy-pair') return;
    abort.current?.abort();
    takePendingLink();
    setPairing(link.pairing); setCode(null); setError(null);
  }), []);

  if (!pairing) return <Page><Placeholder title="No pairing code" message="Create a new code on the computer and scan it again."/></Page>;

  const connect = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const district = legacyDistrict(pairing);
      const session = await signInFromComputer(district, pairing, setCode, controller.signal);
      await prepareWebView(session);
      await activate(district, session.credential);
      router.replace('/');
    } catch (e) { setError(e instanceof Error ? e.message : 'Computer pairing failed.'); setCode(null); }
    finally { abort.current = null; setBusy(false); }
  };

  return <Page>
    <Card style={{ gap: 12 }}>
      <Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800' }}>{pairing.name}</Text>
      <Text style={{ color: palette.muted }}>School: {pairing.portal}</Text>
      <Text style={{ color: palette.muted }}>Workspace: {pairing.workshop}</Text>
      {code ? <>
        <Text style={{ color: palette.ink, fontSize: 30, fontWeight: '800', textAlign: 'center' }}>{code}</Text>
        <Text style={{ color: palette.muted }}>Check that this code matches your computer, then approve in the signed-in Workshop. Only continue if you started this connection.</Text>
      </> : <Button label="Connect this phone" disabled={busy} onPress={() => { void connect(); }}/>}
      {error && <Text accessibilityRole="alert" style={{ color: palette.red }}>{error}</Text>}
      <Button label="Cancel" variant="quiet" onPress={() => { abort.current?.abort(); router.back(); }}/>
    </Card>
  </Page>;
}
