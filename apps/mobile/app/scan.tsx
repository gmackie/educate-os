import { useCallback, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Camera } from 'lucide-react-native';
import { classifyIncomingUrl, setPendingLink } from '../src/links';
import { usePalette } from '../src/ui/theme-context';
import { Button, Card, Field, Loading, Page, Title } from '../src/ui/Primitives';

/** Storyboard 2: the in-app QR scanner, with a fallback when the camera can't be used. */
export default function Scan() {
  const palette = usePalette();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [message, setMessage] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const handled = useRef(false);

  const accept = useCallback((value: string): boolean => {
    const incoming = classifyIncomingUrl(value.trim());
    if (incoming.kind === 'join' || incoming.kind === 'enroll') {
      handled.current = true;
      setPendingLink(incoming);
      router.replace('/connect');
      return true;
    }
    if (incoming.kind === 'legacy-pair') {
      handled.current = true;
      setPendingLink(incoming);
      router.replace('/legacy-pair');
      return true;
    }
    setMessage(incoming.kind === 'invalid' ? incoming.message : "That isn't an EducateOS school code.");
    return false;
  }, [router]);

  const fallback = <Card style={{ gap: 12, marginTop: 18 }}>
    <Text style={{ color: palette.ink, fontWeight: '800', fontSize: 16 }}>Can't scan?</Text>
    <Text style={{ color: palette.muted, lineHeight: 20 }}>
      Your phone's Camera app can open the code too. Or paste the link that came with it, or enter your school's web address.
    </Text>
    <Field label="School code link" value={pasted} onChangeText={setPasted} keyboardType="url"
      placeholder="https://mobile.educateos.io/j#…"/>
    <Button label="Use this link" variant="outline" disabled={pasted.trim().length < 10} onPress={() => { accept(pasted); }}/>
    <Button label="I have a web address" variant="quiet" onPress={() => router.replace('/address')}/>
  </Card>;

  if (!permission) return <Loading label="Checking the camera…"/>;
  if (!permission.granted) {
    return <Page>
      <Title subtitle="EducateOS uses the camera only to read your school's QR code. Nothing is recorded.">Scan the code</Title>
      <View style={{ alignItems: 'center', paddingVertical: 12 }}><Camera size={44} color={palette.primary}/></View>
      {permission.canAskAgain
        ? <Button label="Allow camera" onPress={() => { void requestPermission(); }}/>
        : <>
          <Text style={{ color: palette.muted, lineHeight: 21, marginBottom: 12 }}>
            Camera access is turned off for EducateOS. You can turn it on in Settings.
          </Text>
          <Button label="Open Settings" variant="outline" onPress={() => { void Linking.openSettings(); }}/>
        </>}
      {message && <Text accessibilityRole="alert" style={{ color: palette.red, marginTop: 12 }}>{message}</Text>}
      {fallback}
    </Page>;
  }
  return <View style={{ flex: 1, backgroundColor: '#000' }}>
    <CameraView style={StyleSheet.absoluteFill} facing="back"
      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      onBarcodeScanned={(result) => {
        if (handled.current || !result.data) return;
        accept(result.data);
      }}/>
    <View style={{ position: 'absolute', left: 24, right: 24, top: 28, gap: 8 }}>
      <Text style={{ color: '#FFFFFF', fontSize: 20, fontWeight: '800', textAlign: 'center' }}>Scan the code</Text>
      <Text style={{ color: '#E6EAF2', textAlign: 'center', lineHeight: 20 }}>
        On a computer, open your school site → Connect phone.
      </Text>
    </View>
    <View accessibilityElementsHidden style={{ position: 'absolute', alignSelf: 'center', top: '30%', width: 240, height: 240,
      borderRadius: 28, borderWidth: 3, borderColor: '#FFFFFF' }}/>
    <View style={{ position: 'absolute', left: 20, right: 20, bottom: 36, gap: 10 }}>
      {message && <Text accessibilityRole="alert" style={{ color: '#FFFFFF', textAlign: 'center', backgroundColor: '#000000AA', padding: 10, borderRadius: 12 }}>{message}</Text>}
      <Button label="Enter a web address instead" variant="outline" onPress={() => router.replace('/address')}/>
    </View>
  </View>;
}
