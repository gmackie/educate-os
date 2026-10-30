import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Sparkles } from 'lucide-react-native';
import type { Session } from '../../src/types';
import { useAppState } from '../../src/state/app-state';
import { signIn } from '../../src/auth/auth';
import { prepareWebView, restoreSession } from '../../src/auth/session';
import { tabHref } from '../../src/navigation';
import { homeTab } from '../../src/tabs';
import { Workspace } from '../../src/screens/Workspace';
import { usePalette } from '../../src/ui/theme-context';
import { Button, Loading, Page, Placeholder } from '../../src/ui/Primitives';

/**
 * The AI workspace. A phone connected with a device credential has no web session for it: the
 * Workshop is a web app behind the school's Cloudflare Access, which an embedded web view cannot
 * sign in to well (Google refuses sign-in inside one). So the first time, the school's sign-in
 * runs in the system browser, where Google works and the person may already be signed in, and
 * hands the web session back encrypted (auth.ts); it is kept in SecureStore and set as the web
 * view's cookie, so later visits open straight into the workspace until it expires.
 */
export default function AiTab() {
  const { session, role } = useAppState();
  const router = useRouter();
  if (!session) return null;
  if (session.district.features?.ai === false) {
    return <Page><Placeholder title="AI isn't turned on here"
      message="Your school hasn't enabled the AI workspace. Your classes, calendar and messages still work."/></Page>;
  }
  // Leaving the workspace goes home, not to the school picker.
  const onReturn = () => router.navigate(tabHref(homeTab(role)) as never);
  if (session.credential.kind !== 'device') return <Workspace session={session} onReturn={onReturn}/>;
  return <DeviceWorkspace session={session} onReturn={onReturn}/>;
}

function DeviceWorkspace({ session, onReturn }: { session: Session; onReturn: () => void }) {
  const palette = usePalette();
  const [web, setWeb] = useState<Session | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const district = session.district;

  useEffect(() => {
    let alive = true;
    void restoreSession(district).then(async (stored) => {
      if (stored) await prepareWebView(stored).catch(() => {});
      if (alive) setWeb(stored);
    });
    return () => { alive = false; };
  }, [district]);

  const open = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const signedIn = await signIn(district);
      await prepareWebView(signedIn);
      setWeb(signedIn);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in did not finish. Try again.');
    } finally { setBusy(false); }
  }, [busy, district]);

  if (web === undefined) return <Loading label="Opening your AI workspace…"/>;
  if (web) return <Workspace session={web} onReturn={onReturn}/>;
  return <Page>
    <View style={{ paddingTop: 48, alignItems: 'center', gap: 14 }}>
      <View style={{ backgroundColor: palette.primarySoft, padding: 22, borderRadius: 25 }}>
        <Sparkles size={38} color={palette.primary}/>
      </View>
      <Text style={{ fontSize: 23, color: palette.ink, fontWeight: '800', textAlign: 'center' }}>Open your AI workspace</Text>
      <Text style={{ color: palette.muted, textAlign: 'center', lineHeight: 21, marginBottom: 8 }}>
        Sign in to {district.name} once in the browser. You'll come straight back here, and stay signed in.
      </Text>
      {error && <Text accessibilityRole="alert" style={{ color: palette.red, textAlign: 'center', lineHeight: 20 }}>{error}</Text>}
      <View style={{ alignSelf: 'stretch' }}>
        <Button label={busy ? 'Waiting for sign-in…' : 'Continue'} disabled={busy} onPress={() => { void open(); }}/>
      </View>
    </View>
  </Page>;
}
