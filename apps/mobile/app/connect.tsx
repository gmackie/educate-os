import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { CheckCircle2, GraduationCap, Laptop, QrCode } from 'lucide-react-native';
import type { District } from '../src/types';
import { onPendingLink, takePendingLink, classifyIncomingUrl, type Enrollment, type JoinLink, type PendingLink } from '../src/links';
import { fetchSchoolManifest, speaksMobileApi, supportsPhoneSignIn, type SchoolManifest } from '../src/manifest';
import { districtFromManifest, legacyDistrict } from '../src/schools';
import { CALLBACK_ORIGIN, strictOrigin } from '../src/security';
import { formatCode, pairPhone, PairingError } from '../src/api/pairing';
import { describeDevice, newDeviceKey, storePairedDevice } from '../src/api/deviceVault';
import { useAppState } from '../src/state/app-state';
import { param } from '../src/params';
import { usePalette } from '../src/ui/theme-context';
import { Button, Card, Loading, Page, Placeholder, Title } from '../src/ui/Primitives';

type Target = { origin: string; join?: JoinLink; enrollment?: Enrollment } | { error: string };

function targetOf(link: PendingLink | null, origin: string): Target | null {
  if (link?.kind === 'join') return { origin: link.join.origin, join: link.join };
  if (link?.kind === 'enroll') return { origin: link.enrollment.portal, enrollment: link.enrollment };
  if (link?.kind === 'invalid') return { error: link.message };
  if (origin) {
    try { return { origin: strictOrigin(origin) }; } catch { return { error: 'That school address is not valid.' }; }
  }
  return null;
}

function SchoolCard({ manifest }: { manifest: SchoolManifest }) {
  const palette = usePalette();
  return <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 22 }}>
    {manifest.brand.logo
      ? <Image source={{ uri: manifest.brand.logo }} style={{ width: 48, height: 48, borderRadius: 14 }} resizeMode="contain"/>
      : <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: manifest.brand.accent ?? palette.primary,
        alignItems: 'center', justifyContent: 'center' }}><GraduationCap size={26} color="#FFFFFF"/></View>}
    <View style={{ flex: 1, gap: 3 }}>
      <Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>{manifest.name}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ color: palette.muted, fontSize: 13 }}>{new URL(manifest.origin).host}</Text>
        <CheckCircle2 size={14} color={palette.teal} accessibilityLabel="Verified address"/>
      </View>
    </View>
  </Card>;
}

/**
 * Storyboard 3: the school (name and origin from its manifest), then the 8-character code that must
 * match the computer, then waiting for approval. Without a QR room, it explains how to get one.
 */
export default function Connect() {
  const palette = usePalette();
  const router = useRouter();
  const origin = param(useLocalSearchParams().o);
  const { activate, openSchool } = useAppState();
  const [target, setTarget] = useState<Target | null>(() => targetOf(takePendingLink(), origin));
  const [manifest, setManifest] = useState<SchoolManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A new code scanned (or opened from the Camera app) while this screen is open replaces the old one.
  useEffect(() => onPendingLink((link) => {
    if (link.kind === 'legacy-pair') return;
    abort.current?.abort();
    setTarget(targetOf(takePendingLink(), ''));
    setManifest(null); setManifestError(null); setCode(null); setError(null);
  }), []);
  useEffect(() => () => abort.current?.abort(), []);

  const targetOrigin = target && 'origin' in target ? target.origin : null;
  useEffect(() => {
    if (!targetOrigin) return;
    const controller = new AbortController();
    fetchSchoolManifest(targetOrigin, { signal: controller.signal })
      .then(setManifest, (e: unknown) => {
        if (!controller.signal.aborted) setManifestError(e instanceof Error ? e.message : 'This school could not be checked.');
      });
    return () => controller.abort();
  }, [targetOrigin]);

  const connect = useCallback(async () => {
    if (!manifest || !target || !('join' in target) || !target.join || pairing) return;
    const controller = new AbortController();
    abort.current = controller;
    setPairing(true); setError(null); setCode(null);
    const key = newDeviceKey();
    try {
      const credential = await pairPhone({
        link: target.join, privateKey: key.privateKey, publicJwk: key.publicJwk, device: describeDevice(),
        onCode: setCode, signal: controller.signal,
      });
      const district: District = districtFromManifest(manifest);
      await storePairedDevice(district.origin, key.privateKey, credential);
      await activate(district, { kind: 'device', deviceId: credential.deviceId, principalId: credential.principalId });
      router.replace('/permissions');
    } catch (e) {
      if (!(e instanceof PairingError && e.code === 'cancelled')) {
        setError(e instanceof PairingError ? e.message : 'This phone could not be connected. Make a new code and try again.');
      }
      setCode(null);
    } finally {
      key.privateKey.fill(0);
      abort.current = null;
      setPairing(false);
    }
  }, [manifest, target, pairing, activate, router]);

  const signInHere = useCallback(async (method: string) => {
    if (!manifest) return;
    // Capability-gated (manifest.ts supportsPhoneSignIn): the school's own page signs the person in
    // and hands back a pairing room for this phone as a /j link, which continues as above.
    const start = new URL('/connect-phone', manifest.origin);
    start.searchParams.set('method', method);
    start.searchParams.set('return', 'app');
    const result = await WebBrowser.openAuthSessionAsync(start.href, CALLBACK_ORIGIN + '/j', { preferUniversalLinks: true });
    if (result.type !== 'success') return;
    const incoming = classifyIncomingUrl(result.url);
    if (incoming.kind === 'join' && incoming.join.origin === manifest.origin) setTarget({ origin: manifest.origin, join: incoming.join });
    else setError('Sign-in did not finish. Try again, or connect from a computer.');
  }, [manifest]);

  const legacySignIn = useCallback(async (enrollment: Enrollment) => {
    setError(null);
    try {
      // Schools without a manifest yet: the SCHO-254 Workshop sign-in in the system browser.
      if (await openSchool(legacyDistrict(enrollment))) router.replace('/');
    } catch (e) { setError(e instanceof Error ? e.message : 'The school details are not valid.'); }
  }, [openSchool, router]);

  if (!target) {
    return <Page><Placeholder title="No school chosen" message="Scan your school's code or enter its web address."/>
      <Button label="Scan school code" onPress={() => router.replace('/scan')}/></Page>;
  }
  if ('error' in target) {
    return <Page>
      <Placeholder title="This code can't be used" message={target.error}/>
      <View style={{ gap: 10, marginTop: 16 }}>
        <Button label="Scan again" onPress={() => router.replace('/scan')}/>
        <Button label="I have a web address" variant="outline" onPress={() => router.replace('/address')}/>
      </View>
    </Page>;
  }
  if (manifestError) {
    return <Page>
      <Placeholder title="We couldn't check this school" message={manifestError}/>
      <View style={{ gap: 10, marginTop: 16 }}>
        {target.enrollment && <Button label="Use the older sign-in for this school" variant="outline"
          onPress={() => { void legacySignIn(target.enrollment!); }}/>}
        <Button label="Back" variant="quiet" onPress={() => router.back()}/>
      </View>
    </Page>;
  }
  if (!manifest) return <Loading label="Checking your school…"/>;

  if (!manifest.features.mobile) {
    return <Page><SchoolCard manifest={manifest}/>
      <Placeholder title="Not turned on yet" message="Your school hasn't turned on the EducateOS app. Ask your school for help."/></Page>;
  }
  if (!speaksMobileApi(manifest)) {
    return <Page><SchoolCard manifest={manifest}/>
      <Placeholder title="Update needed" message="This version of EducateOS and your school don't match yet. Update the app, or try again after your school updates."/></Page>;
  }

  if (target.join) {
    return <Page>
      <Title subtitle="Connect this phone to your school.">Is this your school?</Title>
      <SchoolCard manifest={manifest}/>
      {code ? <Card style={{ gap: 14, alignItems: 'center', paddingVertical: 24 }}>
        <Text style={{ color: palette.muted }}>Check this matches your computer:</Text>
        <Text accessibilityLabel={'Code ' + code.split('').join(' ')} selectable
          style={{ color: palette.ink, fontSize: 34, fontWeight: '800', letterSpacing: 3, fontVariant: ['tabular-nums'] }}>
          {formatCode(code)}
        </Text>
        <Loading label="Waiting for approval on the computer…"/>
        <Text style={{ color: palette.muted, fontSize: 12, textAlign: 'center', lineHeight: 18 }}>
          Only approve a connection you started. If the codes don't match, cancel.
        </Text>
      </Card> : <Button label={pairing ? 'Connecting…' : 'Connect this phone'} disabled={pairing} onPress={() => { void connect(); }}/>}
      {error && <Text accessibilityRole="alert" style={{ color: palette.red, marginTop: 14, lineHeight: 20 }}>{error}</Text>}
      {(pairing || error) && <View style={{ marginTop: 12, gap: 10 }}>
        {pairing && <Button label="Cancel" variant="quiet" onPress={() => abort.current?.abort()}/>}
        {error && <Button label="Scan a new code" variant="outline" onPress={() => router.replace('/scan')}/>}
      </View>}
    </Page>;
  }

  const phoneSignIn = supportsPhoneSignIn(manifest);
  return <Page>
    <Title subtitle="Use a computer where you're signed in to your school.">Connect this phone</Title>
    <SchoolCard manifest={manifest}/>
    <Card style={{ gap: 12, marginBottom: 20 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Laptop size={20} color={palette.primary}/>
        <Text style={{ color: palette.ink, fontWeight: '800', fontSize: 16 }}>On your computer</Text>
      </View>
      <Text style={{ color: palette.muted, lineHeight: 21 }}>
        Open {new URL(manifest.origin).host}, choose Connect phone, then scan the code it shows.
      </Text>
      <Button label="Scan the code" onPress={() => router.replace('/scan')} icon={<QrCode size={18} color={palette.onPrimary}/>}/>
    </Card>
    <Card style={{ gap: 12 }}>
      <Text style={{ color: palette.ink, fontWeight: '800', fontSize: 16 }}>No computer?</Text>
      {phoneSignIn
        ? manifest.signIn.map((method) => <Button key={method.id} variant="outline" label={'Sign in with ' + method.label}
          onPress={() => { void signInHere(method.id); }}/>)
        : <Text style={{ color: palette.muted, lineHeight: 21 }}>
          Signing in on this phone is coming soon for {manifest.name}. For now, connect from a computer.
        </Text>}
    </Card>
    {error && <Text accessibilityRole="alert" style={{ color: palette.red, marginTop: 14 }}>{error}</Text>}
  </Page>;
}
