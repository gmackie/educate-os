import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Image, Pressable, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {
  BookOpen, Camera, CheckCircle2, Circle, Ear, Flag, ImagePlus, Laptop, Mic, NotebookText, Paintbrush, PenLine, Rocket, Save, Send,
} from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { ActivityContent, ActivityStep, Assignment, ArtifactView, RevisionContent, UploadMediaType } from '../types';
import {
  isFinished, permittedResources, readiness, spokenFrame, spokenText, stepWork, studentNotes, workByStep, workSteps, workTitle, type StepWork,
} from '../activity.ts';
import { isElementaryBand } from '../gradeBand.ts';
import { imageType, uploadTypeFor } from '../media.ts';
import { usePalette } from '../ui/theme-context';
import { Markdown } from '../ui/Markdown';
import { Button, Card, Chip, dateLabel, Section, useStyles } from '../ui/Primitives';
import { ReadAloudButton, stopReading, useStopReadingOnLeave } from '../ui/ReadAloud';
import { Base64Audio, VoiceRecorder } from '../ui/Audio';
import { DrawingPad } from '../ui/DrawingPad';

// An activity's work on the phone, step by step (SCHO-342), the way the web's activity page keeps
// it (SCHO-323): each step that asks for something is saved as its own artifact in the class
// workspace, and one submission hands in the saved version of every step. The phone submits only
// once every step has saved work. K-2 classes get one step a screen, large type and read-aloud.

/** What the activity's work needs from the district, loaded with the assignment. */
export type ActivityWorkData = {
  saved: Map<string, ArtifactView>; workspaceId: string | null; readOnly: boolean;
};

/** The saved work for each step, from the class workspace (opened only on the first save, never by reading). */
export async function loadActivityWork(client: DistrictClient, offeringId: string, assignment: Assignment,
  content: ActivityContent): Promise<ActivityWorkData> {
  const workspaces = await client.studentWorkspaces();
  const workspace = workspaces.find((w) => w.kind === 'course' && w.offeringId === offeringId);
  const artifacts = workspace ? await client.workspaceArtifacts(workspace.id) : [];
  return { saved: workByStep(assignment.title, content, artifacts), workspaceId: workspace?.id ?? null, readOnly: isFinished(workspace) };
}

/** The student's work on one activity: what is saved, what has unsaved typing, and how to save more. */
type Work = {
  content: ActivityContent; assignment: Assignment; readOnly: boolean; elementary: boolean;
  saved: ReadonlyMap<string, ArtifactView>; unsaved: ReadonlySet<string>;
  ensureWorkspace: () => Promise<string>;
  onSaved: (stepId: string, view: ArtifactView) => void;
  onDirty: (stepId: string, dirty: boolean) => void;
};

function useWork(client: DistrictClient, offeringId: string, assignment: Assignment, content: ActivityContent, data: ActivityWorkData): Work {
  const [saved, setSaved] = useState(data.saved);
  const [unsaved, setUnsaved] = useState<ReadonlySet<string>>(new Set());
  const workspace = useRef<Promise<string> | null>(data.workspaceId ? Promise.resolve(data.workspaceId) : null);
  // The class workspace is opened on the first save rather than on load, so reading an activity never creates anything.
  const ensureWorkspace = useCallback(() => {
    workspace.current ??= client.openCourseWorkspace(offeringId).then((w) => w.id, (e: unknown) => { workspace.current = null; throw e; });
    return workspace.current;
  }, [client, offeringId]);
  const onSaved = useCallback((stepId: string, view: ArtifactView) => setSaved((previous) => new Map(previous).set(stepId, view)), []);
  const onDirty = useCallback((stepId: string, dirty: boolean) => setUnsaved((previous) => {
    if (previous.has(stepId) === dirty) return previous;
    const next = new Set(previous);
    if (dirty) next.add(stepId); else next.delete(stepId);
    return next;
  }), []);
  return { content, assignment, readOnly: data.readOnly, elementary: isElementaryBand(content.gradeBand), saved, unsaved, ensureWorkspace, onSaved, onDirty };
}

const message = (e: unknown, fallback: string) => e instanceof Error && e.message ? e.message : fallback;

/** One step's work, made the way the phone can make it. `young` is the large K-2 size. */
function StepWorkView({ client, work, step, mode, young, schoolHost }: {
  client: DistrictClient; work: Work; step: ActivityStep; mode: StepWork; young: boolean; schoolHost: string;
}) {
  const palette = usePalette();
  const styles = useStyles();
  // The work as saved when the step opened; after that the step keeps its own copy.
  const [initial] = useState(() => work.saved.get(step.id));
  const [current, setCurrent] = useState<ArtifactView | undefined>(initial);
  const [content, setContent] = useState<RevisionContent | 'loading' | 'error' | null>(initial ? 'loading' : null);
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const title = workTitle(work.assignment.title, step);
  const readOnly = work.readOnly;

  // The saved version is read once, when the step opens.
  useEffect(() => {
    if (!initial) return;
    let live = true;
    client.studentArtifact(initial.artifact.id).then((read) => {
      if (!live) return;
      setContent(read.content);
      if (read.content.kind === 'text') { setText(read.content.text); setSavedText(read.content.text); }
    }, () => { if (live) setContent('error'); });
    return () => { live = false; };
  }, [client, initial]);

  const dirty = mode.input === 'writing' && text !== savedText;
  const { onDirty } = work;
  useEffect(() => { onDirty(step.id, dirty); }, [onDirty, step.id, dirty]);

  const saveText = async () => {
    setSaving(true); setError(null); setNotice(null);
    try {
      const view = current ? await client.saveDocumentRevision(current.artifact.id, text)
        : await client.createDocument(await work.ensureWorkspace(), title, text);
      setCurrent(view); setSavedText(text); work.onSaved(step.id, view);
      setNotice('Saved ' + dateLabel(view.head.createdAt, true));
    } catch (e) { setError(message(e, 'Your work was not saved. Check your connection and try again.')); } finally { setSaving(false); }
  };
  /** Saves a picture or recording as the step's next version; resolves true once it is saved. */
  const saveBytes = async (mediaType: UploadMediaType, base64: string): Promise<boolean> => {
    setSaving(true); setError(null); setNotice(null);
    try {
      const view = current ? await client.saveUploadRevision(current.artifact.id, mediaType, base64)
        : await client.createUpload(await work.ensureWorkspace(), title, mode.artifactType, mediaType, base64);
      setCurrent(view); setContent({ kind: 'bytes', base64 }); work.onSaved(step.id, view);
      setNotice(young ? 'Saved!' : 'Saved ' + dateLabel(view.head.createdAt, true));
      return true;
    } catch (e) { setError(message(e, 'Your work was not saved. Check your connection and try again.')); return false; } finally { setSaving(false); }
  };
  const pickPhoto = async (source: 'camera' | 'library') => {
    setError(null);
    // The system photo picker needs no library access: the app sees only the photo chosen.
    if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
      setError('Allow the camera for EducateOS in Settings to take a photo.');
      return;
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7, base64: true, exif: false };
    const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset?.base64) return;
    const type = uploadTypeFor('picture', asset.base64);
    if (!type) { setError('That photo is too large, or not a JPEG or PNG. Try again with a closer, simpler shot.'); return; }
    await saveBytes(type, asset.base64);
  };

  const big = young ? { fontSize: 20, lineHeight: 28 } : { fontSize: 15, lineHeight: 22 };
  const savedBytes = content && typeof content === 'object' && content.kind === 'bytes' ? content.base64 : null;
  const status = <Text style={{ color: palette.muted, fontSize: young ? 16 : 12 }}>
    {readOnly ? 'Read-only' : saving ? 'Saving…' : dirty ? 'Not saved yet' : notice ?? (current ? 'Saved' : 'Not started')}</Text>;

  if (mode.input === 'elsewhere') {
    return <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <Laptop size={22} color={palette.primary}/>
      <Text style={[{ color: palette.muted, flex: 1 }, big]}>
        {current ? 'Your work for this step is saved. ' : ''}Make this step on a computer at {schoolHost}, then come back to submit.</Text>
    </View>;
  }
  return <View style={{ gap: 12 }}>
    {content === 'loading' && <Text style={{ color: palette.muted }}>Opening your saved work…</Text>}
    {content === 'error' && <Text style={{ color: palette.red }}>Your saved work could not be opened. Tap Refresh to try again.</Text>}

    {mode.input === 'writing' && content !== 'loading' && <>
      <TextInput value={text} onChangeText={setText} editable={!readOnly && content !== 'error'} multiline maxLength={30000}
        placeholder={young ? 'Write here…' : 'Write your answer…'} placeholderTextColor={palette.subtle} textAlignVertical="top"
        accessibilityLabel={'Your work for ' + step.title} style={[styles.field, { minHeight: young ? 160 : 140, fontSize: young ? 22 : 15 }]}/>
      {!readOnly && <Button label={saving ? 'Saving…' : 'Save'} disabled={!dirty || !text.trim() || saving || content === 'error'}
        icon={<Save size={18} color={palette.onPrimary}/>} onPress={() => { void saveText(); }}/>}
    </>}

    {(mode.input === 'picture' || mode.input === 'photo') && <>
      {savedBytes && imageType(savedBytes) && <Image accessibilityLabel={'Your saved picture for ' + step.title} resizeMode="contain"
        source={{ uri: 'data:' + imageType(savedBytes) + ';base64,' + savedBytes }}
        style={{ width: '100%', height: young ? 280 : 240, borderRadius: 14, backgroundColor: palette.background }}/>}
      {!readOnly && <>
        {savedBytes && <Text style={{ color: palette.muted, fontSize: young ? 16 : 12 }}>A new drawing or photo replaces this one; your teacher can still see earlier ones.</Text>}
        {/* Keyed by the saved version, so a saved drawing leaves a fresh pad behind. */}
        {mode.input === 'picture' && mode.drawing && <DrawingPad key={current?.head.id ?? 'new'} stepTitle={step.title} disabled={saving}
          onDrawn={(file) => { void saveBytes(file.mediaType, file.base64); }}/>}
        <Text style={{ color: palette.muted, fontSize: young ? 16 : 13 }}>
          {mode.input === 'picture' && mode.drawing ? 'Or take a photo of a picture you made:' : 'Take a clear photo of your work, or choose one you took.'}</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}><Button label="Camera" variant="outline" disabled={saving}
            icon={<Camera size={18} color={palette.primary}/>} onPress={() => { void pickPhoto('camera'); }}/></View>
          <View style={{ flex: 1 }}><Button label="Photos" variant="outline" disabled={saving}
            icon={<ImagePlus size={18} color={palette.primary}/>} onPress={() => { void pickPhoto('library'); }}/></View>
        </View>
      </>}
    </>}

    {mode.input === 'recording' && <>
      {savedBytes && <Base64Audio base64={savedBytes} label={'your saved recording for ' + step.title} large={young}/>}
      {!readOnly && <>
        {savedBytes && <Text style={{ color: palette.muted, fontSize: young ? 16 : 12 }}>A new recording replaces this one; your teacher can still hear earlier ones.</Text>}
        <VoiceRecorder key={current?.head.id ?? 'new'} stepTitle={step.title} disabled={saving} large={young}
          onRecorded={(file) => saveBytes(file.mediaType, file.base64)}/>
      </>}
    </>}

    {error && <Text accessibilityRole="alert" style={{ color: palette.red, lineHeight: 20 }}>{error}</Text>}
    {status}
  </View>;
}

/** Sentence starters a young learner can say or write their answer from, each read aloud on its own. */
function SentenceFrames({ frames, stepId, large }: { frames: string[]; stepId: string; large: boolean }) {
  const palette = usePalette();
  return <View accessibilityLabel="Sentence starters" style={{ gap: 8 }}>
    <Text style={{ color: palette.ink, fontWeight: '800', fontSize: large ? 20 : 14 }}>Try saying:</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{frames.map((frame, i) => <View key={i} style={{ flexDirection: 'row',
      alignItems: 'center', gap: 8, borderWidth: 1, borderColor: palette.line, borderRadius: 24, paddingLeft: 14, paddingRight: 6, paddingVertical: 6,
      backgroundColor: palette.raised }}>
      <Text style={{ color: palette.ink, fontSize: large ? 22 : 15 }}>{frame}</Text>
      <ReadAloudButton id={'frame:' + stepId + ':' + i} text={spokenFrame(frame)} label={'“' + frame + '”'}/>
    </View>)}</View>
  </View>;
}

/** The activity's resources and the teacher's notes for students. */
function Resources({ content, large = false }: { content: ActivityContent; large?: boolean }) {
  const palette = usePalette();
  const resources = permittedResources(content);
  const notes = studentNotes(content);
  if (resources.length === 0 && notes.length === 0) return null;
  return <View style={{ gap: 10 }}>
    {resources.map((r) => <View key={r.key} style={{ flexDirection: 'row', gap: 10 }}>
      <BookOpen size={large ? 26 : 19} color={palette.primary}/>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: palette.ink, fontWeight: '700', fontSize: large ? 20 : 15 }}>{r.title}</Text>
        {r.usedIn.length > 0 && <Text style={{ color: palette.muted, fontSize: large ? 16 : 12 }}>For: {r.usedIn.join(', ')}</Text>}
      </View>
    </View>)}
    {notes.map((note) => <View key={note.id} style={{ flexDirection: 'row', gap: 10 }}>
      <NotebookText size={large ? 26 : 19} color={palette.teal}/>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: palette.ink, fontWeight: '700', fontSize: large ? 20 : 15 }}>{note.title}</Text>
        <Markdown source={note.body} size={large ? 20 : 14}/>
      </View>
    </View>)}
    {resources.length > 0 && <Text style={{ color: palette.muted, fontSize: 12 }}>Your teacher shares these in class or on a computer.</Text>}
  </View>;
}

/** Submit: only once every step has saved work, after a confirmation listing what is handed in. */
function SubmitWork({ client, work, young, canSubmit, attemptsLeft, onSubmitted }: {
  client: DistrictClient; work: Work; young: boolean; canSubmit: boolean; attemptsLeft: number; onSubmitted: () => void;
}) {
  const palette = usePalette();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = readiness(work.content, work.saved, work.unsaved, { young });
  if (work.readOnly) return null;
  if (!canSubmit) return <Text style={{ color: palette.muted }}>You have used all your attempts.</Text>;
  const submit = () => {
    if (!state.ready) return;
    const steps = workSteps(work.content).map((s) => '• ' + s.title).join('\n');
    Alert.alert(young ? 'Hand in your work?' : 'Submit your work?',
      (young ? 'Your teacher will see this work.' : 'Your teacher will see the saved version of each step:') + '\n\n' + steps +
      (young ? '' : '\n\nYou can submit ' + attemptsLeft + ' more ' + (attemptsLeft === 1 ? 'time.' : 'times.')), [
        { text: young ? 'Not yet' : 'Cancel', style: 'cancel' },
        { text: young ? 'Yes, hand it in' : 'Submit', onPress: () => {
          setBusy(true); setError(null);
          client.submit(work.assignment.id, state.revisions).then(() => {
            Alert.alert(young ? 'You did it!' : 'Submitted', young ? 'Your work is handed in. Your teacher will see it soon.'
              : 'Your teacher can now review this work.', [{ text: 'Done', onPress: onSubmitted }]);
          }, (e: unknown) => setError(message(e, 'Your work was not submitted. Try again.'))).finally(() => setBusy(false));
        } },
      ]);
  };
  return <View style={{ gap: 10 }}>
    {young
      ? <Pressable accessibilityRole="button" accessibilityLabel="I'm done!" accessibilityState={{ disabled: !state.ready || busy }}
        disabled={!state.ready || busy} onPress={submit} style={({ pressed }) => ({ flexDirection: 'row', gap: 12, alignItems: 'center',
          justifyContent: 'center', minHeight: 76, borderRadius: 38, backgroundColor: palette.teal, opacity: !state.ready || busy ? 0.45 : pressed ? 0.75 : 1 })}>
        <CheckCircle2 size={34} color="#FFFFFF"/>
        <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 26 }}>{busy ? 'Handing in…' : "I'm done!"}</Text>
      </Pressable>
      : <Button label={busy ? 'Submitting…' : 'Submit'} disabled={!state.ready || busy} icon={<Send size={18} color={palette.onPrimary}/>} onPress={submit}/>}
    {!state.ready && <Text style={{ color: palette.muted, fontSize: young ? 18 : 13, lineHeight: young ? 26 : 19 }}>{state.reason}</Text>}
    {error && <Text accessibilityRole="alert" style={{ color: palette.red }}>{error}</Text>}
  </View>;
}

type Props = {
  client: DistrictClient; offeringId: string; assignment: Assignment; content: ActivityContent; data: ActivityWorkData;
  canSubmit: boolean; attemptsLeft: number; schoolHost: string; onSubmitted: () => void;
};

/** The standard activity page's instructions, resources, work and Submit. Elementary classes get read-aloud and the drawing pad. */
export function ActivityWork({ client, offeringId, assignment, content, data, canSubmit, attemptsLeft, schoolHost, onSubmitted }: Props) {
  const palette = usePalette();
  const work = useWork(client, offeringId, assignment, content, data);
  useStopReadingOnLeave();
  const steps = workSteps(content);
  return <>
    {work.readOnly && <Card style={{ marginBottom: 18 }}><Text style={{ color: palette.muted }}>This class has finished. Your work is read-only now.</Text></Card>}
    <Section title="Instructions">
      <Card style={{ gap: 14 }}>
        <Markdown source={content.overview}/>
        {work.elementary && <ReadAloudButton id="overview" text={spokenText(content.overview)} label="the instructions"/>}
        {content.steps.map((step, i) => <View key={step.id} style={{ gap: 8, borderTopColor: palette.line, borderTopWidth: 1, paddingTop: 12 }}>
          <Text style={{ color: palette.primary, fontSize: 12, fontWeight: '800' }}>STEP {i + 1} · {step.title}</Text>
          <Markdown source={step.prompt} size={14}/>
          {work.elementary && <ReadAloudButton id={'step:' + step.id} text={spokenText(step.prompt)} label={step.title}/>}
          {step.sentenceFrames && <SentenceFrames frames={step.sentenceFrames} stepId={step.id} large={false}/>}
        </View>)}
      </Card>
    </Section>
    {(permittedResources(content).length > 0 || studentNotes(content).length > 0) && <Section title="Resources">
      <Card><Resources content={content}/></Card>
    </Section>}
    {steps.length > 0 && <Section title="My work">
      <View style={{ gap: 12 }}>
        {steps.map((step) => {
          const mode = stepWork(step, { drawing: work.elementary })!;
          return <Card key={step.id} style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: palette.ink, fontWeight: '800', fontSize: 16, flex: 1 }}>{step.title}</Text>
              {work.saved.has(step.id) && !work.unsaved.has(step.id) && <Chip label="Saved" tone="green"/>}
            </View>
            <StepWorkView client={client} work={work} step={step} mode={mode} young={false} schoolHost={schoolHost}/>
          </Card>;
        })}
        <SubmitWork client={client} work={work} young={false} canSubmit={canSubmit} attemptsLeft={attemptsLeft} onSubmitted={onSubmitted}/>
      </View>
    </Section>}
    {steps.length === 0 && <Card style={{ marginBottom: 18 }}><Text style={{ color: palette.muted }}>There's nothing to hand in for this activity.</Text></Card>}
  </>;
}

/** The picture beside a step's title, by what it asks for. */
function stepIcon(step: ActivityStep, color: string): React.ReactNode {
  const r = step.response;
  const Icon = r.kind === 'none' ? (step.sources.length > 0 ? BookOpen : Ear) : r.kind === 'writing' ? PenLine
    : r.kind === 'artifact' && r.artifactType === 'audio' ? Mic : r.kind === 'artifact' && r.artifactType === 'image' ? Paintbrush : NotebookText;
  return <Icon size={40} color={color}/>;
}

/**
 * The young-learner presentation (K-2): a start screen, then one step a screen with large type,
 * "Read to me", its sentence starters and its work, then a finish screen with "I'm done!". Every
 * screen stays mounted, only hidden, so a drawing or recording in progress survives moving between
 * steps. Moving screens stops any reading and returns to the top.
 */
export function YoungActivity({ client, offeringId, assignment, content, data, canSubmit, attemptsLeft, schoolHost, onSubmitted,
  scrollToTop, finish }: Props & { scrollToTop: () => void; finish: React.ReactNode }) {
  const palette = usePalette();
  const work = useWork(client, offeringId, assignment, content, data);
  useStopReadingOnLeave();
  const [page, setPage] = useState(0);
  const steps = content.steps;
  const last = steps.length + 1;
  const go = (next: number) => { stopReading(); setPage(next); scrollToTop(); };
  const needed = workSteps(content);
  const position = page === 0 ? 'Start' : page === last ? 'Finish' : 'Step ' + page + ' of ' + steps.length;
  const heading = (icon: React.ReactNode, title: string) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
    {icon}<Text accessibilityRole="header" style={{ color: palette.ink, fontSize: 30, fontWeight: '800', flex: 1, lineHeight: 36 }}>{title}</Text>
  </View>;
  const shown = (index: number) => ({ display: page === index ? 'flex' as const : 'none' as const, gap: 20 });

  return <View style={{ gap: 20, marginBottom: 24 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} accessibilityLabel={position}>
      <Text style={{ color: palette.ink, fontSize: 20, fontWeight: '800' }}>{position}</Text>
      <View style={{ flexDirection: 'row', gap: 4 }} importantForAccessibility="no-hide-descendants">
        {Array.from({ length: last + 1 }, (_, i) => i < page ? <CheckCircle2 key={i} size={18} color={palette.teal}/>
          : <Circle key={i} size={18} color={i === page ? palette.primary : palette.subtle} fill={i === page ? palette.primary : 'transparent'}/>)}
      </View>
    </View>
    {work.readOnly && <Card><Text style={{ color: palette.muted, fontSize: 18 }}>This class has finished. You can look at your work, but not change it.</Text></Card>}

    <Card style={{ padding: 20 }}>
      <View style={shown(0)}>
        {heading(<Rocket size={40} color={palette.primary}/>, "Let's get started")}
        <Markdown source={content.overview} size={22}/>
        <ReadAloudButton id="young:overview" text={spokenText(content.overview)} label="what this activity is about" prominent/>
        {(permittedResources(content).length > 0 || studentNotes(content).length > 0) && <View style={{ gap: 10 }}>
          <Text style={{ color: palette.ink, fontSize: 22, fontWeight: '800' }}>Look at these</Text>
          <Resources content={content} large/>
        </View>}
      </View>

      {steps.map((step, index) => {
        const mode = stepWork(step, { drawing: true });
        return <View key={step.id} style={shown(index + 1)}>
          {heading(stepIcon(step, palette.primary), step.title)}
          <Markdown source={step.prompt} size={22}/>
          <ReadAloudButton id={'young:step:' + step.id} text={spokenText(step.prompt)} label={'step ' + (index + 1) + ', ' + step.title} prominent/>
          {step.sentenceFrames && <SentenceFrames frames={step.sentenceFrames} stepId={step.id} large/>}
          {mode && <StepWorkView client={client} work={work} step={step} mode={mode} young schoolHost={schoolHost}/>}
        </View>;
      })}

      <View style={shown(last)}>
        {heading(<Flag size={40} color={palette.primary}/>, 'All done?')}
        {needed.length === 0 ? <Text style={{ color: palette.ink, fontSize: 22 }}>There's nothing to hand in. Great listening!</Text> : <>
          <Text style={{ color: palette.ink, fontSize: 22, lineHeight: 30 }}>
            {needed.every((s) => work.saved.has(s.id)) ? 'You saved all your work.'
              : 'You saved ' + needed.filter((s) => work.saved.has(s.id)).length + ' of ' + needed.length + '. Go back to finish the rest.'}</Text>
          <View style={{ gap: 10 }}>{needed.map((step) => {
            const done = work.saved.has(step.id) && !work.unsaved.has(step.id);
            return <Pressable key={step.id} accessibilityRole="button" accessibilityLabel={step.title + (done ? ', saved' : ', not saved yet') + '. Go to this step'}
              onPress={() => go(steps.indexOf(step) + 1)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 }}>
              {done ? <CheckCircle2 size={30} color={palette.teal}/> : <Circle size={30} color={palette.subtle}/>}
              <Text style={{ color: palette.ink, fontSize: 20, flex: 1 }}>{step.title}</Text>
            </Pressable>;
          })}</View>
          <SubmitWork client={client} work={work} young canSubmit={canSubmit} attemptsLeft={attemptsLeft} onSubmitted={onSubmitted}/>
        </>}
        {finish}
      </View>
    </Card>

    <View style={{ flexDirection: 'row', gap: 12 }}>
      {page > 0 && <BigNav label="Back" onPress={() => go(page - 1)} primary={false}/>}
      {page < last && <BigNav label={page === 0 ? "Let's start" : page === steps.length ? 'Finish' : 'Next'} onPress={() => go(page + 1)} primary/>}
    </View>
  </View>;
}

function BigNav({ label, onPress, primary }: { label: string; onPress: () => void; primary: boolean }) {
  const palette = usePalette();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ flex: 1, minHeight: 64,
    borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: primary ? 0 : 2, borderColor: palette.line,
    backgroundColor: primary ? palette.primary : palette.raised, opacity: pressed ? 0.75 : 1 })}>
    <Text style={{ color: primary ? palette.onPrimary : palette.primary, fontSize: 22, fontWeight: '800' }}>{label}</Text>
  </Pressable>;
}

