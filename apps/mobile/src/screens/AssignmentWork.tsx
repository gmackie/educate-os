import { useState } from 'react';
import { Alert, Image, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { BookOpen, Camera, ImagePlus, Laptop, PenLine, Send } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Detail, QuizSummary } from '../types';
import { usePalette } from '../ui/theme-context';
import { Markdown } from '../ui/Markdown';
import { Button, Card, Chip, Item, Section } from '../ui/Primitives';
import { imageType } from '../media.ts';

/** The district's upload limit (`MAX_UPLOAD_BYTES`): 5 MiB, sent as base64. */
const MAX_PHOTO_BASE64 = Math.ceil((5 * 1024 * 1024) / 3) * 4;

type Photo = { uri: string; base64: string; mediaType: 'image/jpeg' | 'image/png' };

/**
 * A photo of the student's own work, from the camera or their library, submitted as an `image` or
 * `evidence` artifact in the class workspace. Nothing is kept on the phone after it is sent.
 */
export function PhotoSubmission({ client, assignmentId, offeringId, type, onSubmitted }: {
  client: DistrictClient; assignmentId: string; offeringId: string; type: 'image' | 'evidence'; onSubmitted: () => void;
}) {
  const palette = usePalette();
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (source: 'camera' | 'library') => {
    setError(null);
    // The system photo picker needs no library access: the app sees only the photo chosen.
    if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
      setError('Allow camera access in Settings to take a photo.');
      return;
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7, base64: true, exif: false };
    const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset?.base64) return;
    if (asset.base64.length > MAX_PHOTO_BASE64) { setError('That photo is too large. Try again with a closer, simpler shot.'); return; }
    setPhoto({ uri: asset.uri, base64: asset.base64, mediaType: asset.mimeType === 'image/png' ? 'image/png' : 'image/jpeg' });
  };
  const submit = () => {
    if (!photo) return;
    Alert.alert('Submit this photo?', 'Your teacher will receive it as your work for this assignment.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Submit', onPress: () => {
        setBusy(true); setError(null);
        void (async () => {
          const workspace = await client.openCourseWorkspace(offeringId);
          const created = await client.createUpload(workspace.id, 'Photo of my work', type, photo.mediaType, photo.base64);
          await client.submitDocument(assignmentId, { artifactId: created.artifact.id, revisionId: created.head.id });
          setPhoto(null);
          onSubmitted();
        })().catch((e: unknown) => setError(e instanceof Error ? e.message : 'The photo could not be submitted.')).finally(() => setBusy(false));
      } },
    ]);
  };

  return <Card style={{ gap: 12 }}>
    <Text style={{ color: palette.ink, fontWeight: '800', fontSize: 16 }}>Submit a photo of your work</Text>
    {photo
      ? <Image source={{ uri: photo.uri }} accessibilityLabel="The photo you chose" resizeMode="contain"
        style={{ width: '100%', height: 260, borderRadius: 14, backgroundColor: palette.background }}/>
      : <Text style={{ color: palette.muted, lineHeight: 20 }}>Take a clear photo of paper work, a project or a lab, or choose one you already took.</Text>}
    {error && <Text accessibilityRole="alert" style={{ color: palette.red }}>{error}</Text>}
    {photo ? <>
      <Button label={busy ? 'Submitting…' : 'Submit photo'} disabled={busy} icon={<Send size={18} color={palette.onPrimary}/>} onPress={submit}/>
      <Button label="Choose a different photo" variant="quiet" disabled={busy} onPress={() => setPhoto(null)}/>
    </> : <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ flex: 1 }}><Button label="Camera" variant="outline" icon={<Camera size={18} color={palette.primary}/>} onPress={() => { void pick('camera'); }}/></View>
      <View style={{ flex: 1 }}><Button label="Photos" variant="outline" icon={<ImagePlus size={18} color={palette.primary}/>} onPress={() => { void pick('library'); }}/></View>
    </View>}
  </Card>;
}

/**
 * How the student does an assignment here: the quiz it is bound to, a written response, a photo,
 * or, for work the phone can't make (notebooks, spreadsheets, projects), where to do it instead.
 */
export function AssignmentActions({ client, assignmentId, offeringId, permitted, quiz, ai, schoolHost, navigate, onSubmitted }: {
  client: DistrictClient; assignmentId: string; offeringId: string; permitted: string[]; quiz: QuizSummary | null;
  ai: boolean; schoolHost: string; navigate: (d: Detail) => void; onSubmitted: () => void;
}) {
  const palette = usePalette();
  const photoType = permitted.includes('evidence') ? 'evidence' : permitted.includes('image') ? 'image' : null;
  const native = !!quiz || permitted.includes('document') || !!photoType;
  return <View style={{ gap: 12, marginBottom: 18 }}>
    {quiz && <Button label={quiz.attempts.some((a) => a.status === 'in-progress') ? 'Resume the quiz' : 'Take the quiz'}
      icon={<PenLine size={18} color={palette.onPrimary}/>} onPress={() => navigate({ type: 'quiz', offeringId, quizId: quiz.id })}/>}
    {permitted.includes('document') && <Button label="Write a response" variant={quiz ? 'outline' : 'primary'}
      icon={<PenLine size={18} color={quiz ? palette.primary : palette.onPrimary}/>}
      onPress={() => navigate({ type: 'write', id: assignmentId, offeringId })}/>}
    {photoType && <PhotoSubmission client={client} assignmentId={assignmentId} offeringId={offeringId} type={photoType} onSubmitted={onSubmitted}/>}
    {!native && <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <Laptop size={22} color={palette.primary}/>
      <Text style={{ color: palette.muted, lineHeight: 21, flex: 1 }}>
        {ai ? 'This assignment is made in the AI tab or on a computer at ' + schoolHost + '.'
          : 'This assignment is made on a computer. Open ' + schoolHost + ' there to work on it.'}
      </Text>
    </Card>}
  </View>;
}

/** Starter materials from the teacher, opened in place: text as Markdown, pictures inline. */
export function StarterMaterials({ client, assignmentId, materials }: {
  client: DistrictClient; assignmentId: string; materials: { id: string; title: string }[];
}) {
  const palette = usePalette();
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, Awaited<ReturnType<DistrictClient['starterMaterial']>>['content'] | 'error'>>({});
  const toggle = (id: string) => {
    setOpen(open === id ? null : id);
    if (content[id]) return;
    client.starterMaterial(assignmentId, id).then((m) => setContent((c) => ({ ...c, [id]: m.content })),
      () => setContent((c) => ({ ...c, [id]: 'error' })));
  };
  return <Section title="Starter materials">
    <Card>{materials.map((item) => {
      const body = content[item.id];
      return <View key={item.id}>
        <Item title={item.title} detail={open === item.id ? 'Tap to close' : 'From your teacher'}
          leading={<BookOpen size={19} color={palette.primary}/>} onPress={() => toggle(item.id)}/>
        {open === item.id && <View style={{ paddingBottom: 12 }}>
          {!body ? <Text style={{ color: palette.muted }}>Opening…</Text>
            : body === 'error' ? <Text style={{ color: palette.red }}>This material could not be opened.</Text>
            : body.kind === 'text' ? <Markdown source={body.text}/>
            : body.kind === 'bytes' && imageType(body.base64) ? <Image accessibilityLabel={item.title} resizeMode="contain"
              source={{ uri: 'data:' + imageType(body.base64) + ';base64,' + body.base64 }}
              style={{ width: '100%', height: 280, borderRadius: 12 }}/>
            : <Chip label={body.kind === 'external' ? 'Opens on a computer' : 'Open this file on a computer'} tone="neutral"/>}
        </View>}
      </View>;
    })}</Card>
  </Section>;
}
