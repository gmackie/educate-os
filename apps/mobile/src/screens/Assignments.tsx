import { useState } from 'react';
import { Alert, Text, TextInput, View } from 'react-native';
import { BookOpen, FilePenLine, GraduationCap, Send } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Detail } from '../types';
import { useLoad } from '../hooks/useLoad';
import { palette } from '../theme';
import { Button, Card, Chip, dateLabel, Field, Item, Page, QueryState, Section, Title } from '../ui/Primitives';


/** Never renders staff-only fields or answer keys; the district returns a student-filtered activity view. */
export function AssignmentScreen({ client, assignmentId, offeringId, navigate }: {
  client: DistrictClient; assignmentId: string; offeringId: string; navigate: (d: Detail) => void;
}) {
  const [result, reload] = useLoad('assignment:' + assignmentId, async () => {
    const [details, submissions, grades] = await Promise.all([
      client.studentAssignment(assignmentId), client.studentSubmissions(assignmentId),
      client.studentOfficialGrades(assignmentId).catch(() => []),
    ]);
    const activity = await client.studentActivity(details.assignment.activityId).catch(() => null);
    const feedback = await client.studentAssignmentFeedback(assignmentId).catch(() => []);
    return { details, submissions, grades, activity, feedback };
  });
  return <Page refresh={reload}>
    <QueryState state={result} retry={reload}>{({ details, submissions, grades, activity, feedback }) => <>
      <Title subtitle={'Due ' + dateLabel(details.assignment.dueAt, true)}>{details.assignment.title}</Title>
      <View style={{ gap: 11, flexDirection: 'row', marginBottom: 24 }}>
        <Chip label={submissions.some((s) => !s.withdrawnAt) ? 'Submitted' : 'Not submitted'}
          tone={submissions.some((s) => !s.withdrawnAt) ? 'green' : 'amber'}/>
        <Chip label={submissions.length + '/' + details.assignment.attemptsAllowed + ' attempts'} tone="neutral"/>
      </View>
      {activity && <Section title="Instructions">
        <Card style={{ gap: 14 }}>
          <Text style={{ color: palette.ink, fontSize: 15, lineHeight: 23 }}>
            {activity.content.overview}</Text>
          {activity.content.steps.map((step, i) => <View key={step.id} style={{ gap: 6,
            borderTopColor: palette.line, borderTopWidth: 1, paddingTop: 12 }}>
            <Text style={{ color: palette.primary, fontSize: 12, fontWeight: '800' }}>
              STEP {i + 1} · {step.title}
            </Text>
            <Text style={{ color: palette.ink, fontSize: 14, lineHeight: 22 }}>{step.prompt}</Text>
          </View>)}
        </Card>
      </Section>}
      {details.starterMaterials && details.starterMaterials.length > 0 && <Section title="Starter materials">
        <Card>{details.starterMaterials.map((item) => <Item key={item.id} title={item.title}
          detail="Reference from your teacher" leading={<BookOpen size={19} color={palette.primary}/>}/>)}</Card>
      </Section>}
      <Section title="My submission">
        <Card style={{ gap: 12 }}>
          {submissions.length === 0 ? <Text style={{ color: palette.muted }}>No work submitted yet.</Text> :
            submissions.map((s) => <View key={s.id} style={{ gap: 5, paddingVertical: 7 }}>
              <Chip label={s.withdrawnAt ? 'Withdrawn' : 'Submitted'} tone={s.withdrawnAt ? 'neutral' : 'green'}/>
              <Text style={{ color: palette.ink, fontWeight: '700' }}>Attempt {s.attempt}</Text>
              <Text style={{ color: palette.muted, fontSize: 12 }}>{dateLabel(s.submittedAt, true)}</Text>
            </View>)}
          {grades.length > 0 && <View style={{ marginTop: 10, borderTopWidth: 1,
            borderColor: palette.line, paddingTop: 14 }}>
            <Text style={{ color: palette.ink, fontWeight: '800' }}>Official grade</Text>
            <Text style={{ color: palette.primary, fontSize: 22, fontWeight: '800' }}>
              {grades.at(-1)!.score.points} / {grades.at(-1)!.score.maxPoints}
            </Text>
          </View>}
        </Card>
      </Section>
      {feedback.length > 0 && <Section title="Teacher feedback">
        <Card style={{ gap: 14 }}>{feedback.flatMap((record) => record.comments).map((comment, i) =>
          <Text key={i} style={{ color: palette.ink, lineHeight: 23 }}>{comment.body}</Text>)}
        </Card>
      </Section>}
      {details.assignment.permittedArtifactTypes?.includes('document') ?
        <Button label="Write a response" icon={<FilePenLine size={19} color={palette.white}/>}
          onPress={() => navigate({ type: 'write', id: assignmentId, offeringId })}/> :
        <Card style={{ marginBottom: 18 }}>
          <Text style={{ color: palette.muted, lineHeight: 21 }}>
            This assignment uses a quiz or another type of learning artifact. Open your school's complete learning experience in the AI Workspace.
          </Text>
        </Card>}
      <View style={{ height: 24 }}/>
    </>}</QueryState>
  </Page>;
}

/**
 * Native text submission. Writes only on explicit save/submit; no device-side student-work cache.
 * A failed submit leaves a reusable artifact/revision pair, preventing duplicate writes on retry.
 */
export function WriteResponse({ client, assignmentId, offeringId, onComplete }: {
  client: DistrictClient; assignmentId: string; offeringId: string; onComplete: () => void;
}) {
  const [title, setTitle] = useState('');
  const [response, setResponse] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ artifactId: string; revisionId: string; text: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const disabled = saving || response.trim().length < 2 || title.trim().length < 2;
  const submit = async (final: boolean) => {
    if (disabled) return;
    setSaving(true); setError(null);
    try {
      let revision = saved;
      if (!revision) {
        const { assignment } = await client.studentAssignment(assignmentId);
        if (!assignment.permittedArtifactTypes?.includes('document')) {
          throw new Error('This assignment does not accept written documents. Open it in your school workspace.');
        }
        const workspace = await client.openCourseWorkspace(offeringId);
        const created = await client.createDocument(workspace.id, title.trim(), response.trim());
        revision = { artifactId: created.artifact.id, revisionId: created.head.id, text: response.trim(), title: title.trim() };
        setSaved(revision);
      } else if (revision.text !== response.trim()) {
        const next = await client.saveDocumentRevision(revision.artifactId, response.trim());
        revision = { ...revision, revisionId: next.head.id, text: response.trim() };
        setSaved(revision);
      }
      if (final) {
        const submission = await client.submitDocument(assignmentId, revision);
        setReceipt(submission.submissionId);
        Alert.alert('Work submitted', 'Your teacher can now review this response.', [
          { text: 'Done', onPress: onComplete },
        ]);
      } else {
        Alert.alert('Saved to your class', 'Your answer is saved in your school workspace. Submit when ready.');
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save your work.'); }
    finally { setSaving(false); }
  };
  return <Page>
    <Title subtitle="Your response stays on your school's server, and is shared only when you submit it.">
      Written response
    </Title>
    <Card style={{ gap: 15, marginBottom: 18 }}>
      <Field label="Title" value={title} onChangeText={(s) => { if (!saved) setTitle(s); }}
        placeholder="My response"/>
      <Text style={{ fontWeight: '700', color: palette.ink }}>Your writing</Text>
      <TextInput value={response} onChangeText={setResponse}
        multiline placeholder="Begin writing your response here…" placeholderTextColor={palette.subtle}
        textAlignVertical="top" maxLength={30000}
        style={{ minHeight: 235, padding: 14, borderWidth: 1, borderColor: palette.line,
          borderRadius: 14, backgroundColor: palette.white, fontSize: 15,
          lineHeight: 24, color: palette.ink }}/>
      <Text style={{ color: palette.muted, fontSize: 12 }}>{response.length.toLocaleString()} characters</Text>
      <Text style={{ color: palette.muted, lineHeight: 20, fontSize: 12 }}>
        Keep this page open until your work is saved. A saved response can be found later in your school workspace.
      </Text>
    </Card>
    {error && <Text accessibilityRole="alert" style={{ color: palette.red, paddingBottom: 15 }}>{error}</Text>}
    {receipt ? <Card><Chip label="Submitted" tone="green"/>
      <Text style={{ color: palette.muted, marginTop: 8 }}>Your school issued a submission receipt.</Text></Card> :
      <View style={{ gap: 12, paddingBottom: 30 }}>
        <Button label={saving ? 'Saving…' : 'Save to class'} disabled={disabled} variant="outline"
          onPress={() => void submit(false)}/>
        <Button label={saving ? 'Submitting…' : 'Submit response'} disabled={disabled}
          icon={<Send size={18} color={palette.white}/>}
          onPress={() => Alert.alert('Submit this response?', 'Your teacher will receive the saved version of this work.', [
            { text: 'Cancel', style: 'cancel' }, { text: 'Submit', onPress: () => { void submit(true); } },
          ])}/>
      </View>}
  </Page>;
}

export function StudentGrades({ client, navigate }: {
  client: DistrictClient; navigate: (d: Detail) => void;
}) {
  const [data, retry] = useLoad('student-grades', async () => {
    const classes = await client.studentClasses();
    return Promise.all(classes.map(async (course) => {
      const summary = await client.studentGradeSummary(course.offering.id).catch(() => null);
      return { course, summary };
    }));
  });
  return <Page refresh={retry}>
    <Title subtitle="Only official, released grades. Draft AI scores are not displayed.">My grades</Title>
    <QueryState state={data} retry={retry} empty={(v) => v.length === 0} emptyText="No classes yet.">
      {(courses) => <View style={{ gap: 12 }}>{courses.map(({ course, summary }) =>
        <Card key={course.offering.id}>
          <Item title={course.course.title} detail={course.offering.sectionName}
            leading={<GraduationCap size={21} color={palette.primary}/>}
            trailing={<Chip label={typeof summary?.row?.totals?.final === 'number' ?
              summary.row.totals.final.toFixed(1) + '%' : 'No grade'} tone="neutral"/>}
            onPress={() => navigate({ type: 'class', id: course.offering.id })}/>
          {summary?.row?.totals?.letter && <Text style={{ color: palette.muted, paddingTop: 8 }}>
            Letter grade: {summary.row.totals.letter}</Text>}
        </Card>)}</View>}
    </QueryState>
  </Page>;
}

export function Announcements({ client }: { client: DistrictClient }) {
  const [data, retry] = useLoad('announcements', () => client.studentAnnouncements());
  return <Page refresh={retry}>
    <Title subtitle="Official classroom messages from your teachers.">Announcements</Title>
    <QueryState state={data} retry={retry} empty={(v) => v.length === 0} emptyText="No new announcements.">
      {(list) => <View style={{ gap: 12 }}>{list.map(({ announcement, courseLabel }) =>
        <Card key={announcement.id} style={{ gap: 12 }}>
          <Text style={{ color: palette.primary, fontSize: 12, fontWeight: '700' }}>{courseLabel}</Text>
          <Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>{announcement.title}</Text>
          <Text style={{ color: palette.muted, fontSize: 12 }}>{dateLabel(announcement.publishAt, true)}</Text>
          <Text style={{ color: palette.ink, lineHeight: 23 }}>{announcement.body}</Text>
        </Card>)}</View>}
    </QueryState>
  </Page>;
}
