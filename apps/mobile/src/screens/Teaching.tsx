import { useState } from 'react';
import { Alert, Text, TextInput, View } from 'react-native';
import { CheckCircle2, FileText, Megaphone, MessagesSquare, NotebookPen, PenLine } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Detail, Gradebook, QuizQuestion, QuizResponse, StaffAttempt } from '../types';
import { useLoad, useReloadOnFocus } from '../hooks/useLoad';
import { usePalette } from '../ui/theme-context';
import { Markdown } from '../ui/Markdown';
import { localInput, parseLocal } from '../dates.ts';
import { Button, Card, Chip, dateLabel, Field, Item, Page, Placeholder, QueryState, Section, Title, useStyles } from '../ui/Primitives';

/**
 * A teacher's class beyond assignments and roster: announcements (and posting one), the week's note
 * to families, module pages, quizzes with work to grade, and discussions needing attention.
 */
export function TeacherClassHub({ client, offeringId, navigate }: { client: DistrictClient; offeringId: string; navigate: (d: Detail) => void }) {
  const palette = usePalette();
  const [state, reload] = useLoad('teacher-hub:' + offeringId, async () => {
    const [announcements, note, outline, quizzes, discussions] = await Promise.all([
      client.teacherAnnouncements(offeringId).catch(() => []),
      client.weeklyNote(offeringId).catch(() => null),
      client.teacherModules(offeringId).catch(() => null),
      client.teacherQuizzes(offeringId).then((q) => q.quizzes, () => []),
      client.discussions('teacher', offeringId).catch(() => null),
    ]);
    return { announcements, note, outline: outline?.outline ?? null, quizzes, discussions };
  });
  useReloadOnFocus(reload);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [noteText, setNoteText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = (work: () => Promise<unknown>, done: string) => {
    setBusy(true); setMessage(null);
    work().then(() => { setMessage(done); reload(); }, (e: unknown) => setMessage(e instanceof Error ? e.message : 'That did not save.'))
      .finally(() => setBusy(false));
  };
  const post = () => Alert.alert('Post this announcement?', 'Everyone in the class sees it, and families see it in their digest.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Post', onPress: () => run(async () => {
      await client.createAnnouncement(offeringId, title.trim(), body.trim());
      setTitle(''); setBody(''); setComposing(false);
    }, 'Announcement posted.') },
  ]);

  return <QueryState state={state} retry={reload}>{(data) => <>
    {message && <Text accessibilityRole="alert" style={{ color: palette.muted, marginBottom: 14 }}>{message}</Text>}
    <Section title="Announcements">
      {composing && <Card style={{ gap: 12, marginBottom: 12 }}>
        <Field label="Title" value={title} onChangeText={setTitle} placeholder="Library visit on Friday"/>
        <Field label="Message" value={body} onChangeText={setBody} placeholder="What students need to know…" multiline/>
        <Button label={busy ? 'Posting…' : 'Post announcement'} disabled={busy || !title.trim() || !body.trim()} onPress={post}/>
        <Button label="Cancel" variant="quiet" onPress={() => setComposing(false)}/>
      </Card>}
      {data.announcements.length > 0 && <Card style={{ marginBottom: 12 }}>{data.announcements.slice(0, 5).map(({ announcement, published }) =>
        <Item key={announcement.id} title={announcement.title}
          detail={(published ? '' : 'Scheduled · ') + dateLabel(announcement.publishAt, true)}
          leading={<Megaphone size={19} color={palette.teal}/>}/>)}</Card>}
      {!composing && <Button label="Post an announcement" variant="outline" icon={<Megaphone size={17} color={palette.primary}/>}
        onPress={() => setComposing(true)}/>}
    </Section>

    {data.note && <Section title={'Note to families · ' + data.note.week}>
      <Card style={{ gap: 12 }}>
        {noteText === null ? <>
          {data.note.note ? <Markdown source={data.note.note.text}/> : <Text style={{ color: palette.muted }}>
            No note this week. Families get it in their weekly digest.</Text>}
          <Button label={data.note.note ? 'Edit note' : 'Write a note'} variant="outline" icon={<NotebookPen size={17} color={palette.primary}/>}
            onPress={() => setNoteText(data.note!.note?.text ?? '')}/>
        </> : <>
          <Field label="This week's note" value={noteText} onChangeText={setNoteText} multiline placeholder="What we're learning this week…"/>
          <Button label={busy ? 'Saving…' : 'Save note'} disabled={busy}
            onPress={() => run(async () => { await client.setWeeklyNote(offeringId, noteText.trim()); setNoteText(null); }, 'Note saved.')}/>
          <Button label="Cancel" variant="quiet" onPress={() => setNoteText(null)}/>
        </>}
      </Card>
    </Section>}

    {data.quizzes.length > 0 && <Section title="Quizzes">
      <Card>{data.quizzes.map(({ quiz, submitted, needsGrading }) => <Item key={quiz.id} title={quiz.title}
        detail={submitted + ' submitted' + (quiz.status !== 'published' ? ' · ' + quiz.status : '')}
        leading={<PenLine size={19} color={palette.primary}/>}
        trailing={needsGrading > 0 ? <Chip label={needsGrading + ' to grade'} tone="amber"/> : undefined}
        onPress={() => navigate({ type: 'quiz', offeringId, quizId: quiz.id })}/>)}</Card>
    </Section>}

    {data.discussions && data.discussions.topics.length > 0 && <Section title="Discussions">
      <Card>{data.discussions.topics.map(({ topic, posts, needsAttention }) => <Item key={topic.id} title={topic.title}
        detail={posts === 1 ? '1 post' : posts + ' posts'} leading={<MessagesSquare size={19} color={palette.primary}/>}
        trailing={needsAttention > 0 ? <Chip label={needsAttention + ' need you'} tone="amber"/> : undefined}
        onPress={() => navigate({ type: 'discussion', offeringId, topicId: topic.id })}/>)}</Card>
    </Section>}

    {data.outline && data.outline.pages.length > 0 && <Section title="Module pages">
      <Card>{data.outline.modules.flatMap((m) => m.items.flatMap((item) => {
        const page = item.kind === 'page' ? data.outline!.pages.find((p) => p.id === item.pageId) : undefined;
        return page ? [<Item key={item.id} title={page.title} detail={m.title + (m.published ? '' : ' · Draft')}
          leading={<FileText size={19} color={palette.primary}/>} onPress={() => navigate({ type: 'page', offeringId, pageId: page.id })}/>] : [];
      }))}</Card>
    </Section>}
  </>}</QueryState>;
}

/** The class gradebook: each student's total, and their scores per assignment on tap. */
export function GradebookView({ gradebook }: { gradebook: Gradebook }) {
  const palette = usePalette();
  const [open, setOpen] = useState<string | null>(null);
  if (gradebook.rows.length === 0) return <Placeholder title="No students" message="Grades appear once students are enrolled."/>;
  return <Card>{gradebook.rows.map((row) => <View key={row.studentPrincipalId}>
    <Item title={row.displayName}
      detail={row.totals.points ? row.totals.points.earned + ' / ' + row.totals.points.possible + ' points' : 'No graded work yet'}
      trailing={<Chip label={typeof row.totals.final === 'number' ? row.totals.final.toFixed(1) + '%' + (row.totals.letter ? ' ' + row.totals.letter : '') : '—'}
        tone={typeof row.totals.final === 'number' ? 'green' : 'neutral'}/>}
      onPress={() => setOpen(open === row.studentPrincipalId ? null : row.studentPrincipalId)}/>
    {open === row.studentPrincipalId && <View style={{ paddingLeft: 12, paddingBottom: 10, gap: 8 }}>
      {gradebook.columns.map((column) => {
        const cell = row.cells.find((c) => c.assignmentId === column.assignmentId);
        return <View key={column.assignmentId} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Text style={{ color: palette.ink, flex: 1 }} numberOfLines={1}>{column.title}</Text>
          <Text style={{ color: cell?.score ? palette.ink : palette.subtle, fontWeight: '700' }}>
            {cell?.score ? cell.score.points + '/' + cell.score.maxPoints : cell?.marker ?? '—'}{cell?.dropped ? ' (dropped)' : ''}</Text>
        </View>;
      })}
    </View>}
  </View>)}</Card>;
}

/** `/class/<offering>/quiz/<quiz>` for staff: who has taken it, item statistics, essays to grade, and releasing scores. */
export function TeacherQuiz({ client, offeringId, quizId }: { client: DistrictClient; offeringId: string; quizId: string }) {
  const palette = usePalette();
  const [state, reload] = useLoad('teacher-quiz:' + quizId, () => client.quizResults(offeringId, quizId));
  const [grading, setGrading] = useState<StaffAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const openAttempt = (attemptId: string) => {
    setBusy(true);
    client.staffQuizAttempt(offeringId, attemptId).then(setGrading, (e: unknown) => setMessage(e instanceof Error ? e.message : 'Could not open it.'))
      .finally(() => setBusy(false));
  };
  if (grading) return <GradeAttempt client={client} offeringId={offeringId} attempt={grading} onDone={() => { setGrading(null); reload(); }}/>;

  return <Page refresh={reload}><QueryState state={state} retry={reload}>{(results) => {
    const names = new Map(results.names.map((n) => [n.principalId, n.displayName]));
    const waiting = results.students.filter((s) => s.needsGrading).length;
    return <>
      <Title subtitle={results.students.length === 1 ? '1 student has taken it' : results.students.length + ' students have taken it'}>{results.quiz.title}</Title>
      {message && <Text accessibilityRole="alert" style={{ color: palette.muted, marginBottom: 12 }}>{message}</Text>}
      <View style={{ gap: 10, marginBottom: 22 }}>
        {waiting > 0 && <Chip label={waiting + (waiting === 1 ? ' student has' : ' students have') + ' essays to grade'} tone="amber"/>}
        <Button label={busy ? 'Releasing…' : results.releasable > 0 ? 'Release ' + results.releasable + (results.releasable === 1 ? ' score' : ' scores') : 'Nothing to release yet'}
          disabled={busy || results.releasable === 0} onPress={() => Alert.alert('Release scores?',
            'Students see their scores, and the scores become official grades.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Release', onPress: () => {
                setBusy(true);
                client.releaseQuizScores(offeringId, quizId).then((r) => { setMessage(r.official === 1 ? '1 grade made official.' : r.official + ' grades made official.'); reload(); },
                  (e: unknown) => setMessage(e instanceof Error ? e.message : 'Release failed.')).finally(() => setBusy(false));
              } },
            ])}/>
      </View>
      <Section title="Students">
        {results.students.length === 0 ? <Placeholder title="No attempts yet" message="Attempts appear here as students submit."/> :
          <Card>{results.students.flatMap((student) => student.attempts.filter((a) => a.status !== 'in-progress').map((attempt) =>
            <Item key={attempt.id} title={(names.get(student.studentId) ?? 'Student') + ' · attempt ' + attempt.number}
              detail={attempt.submittedAt ? 'Submitted ' + dateLabel(attempt.submittedAt, true) : attempt.status}
              trailing={<Chip label={attempt.points === null ? 'Needs grading' : attempt.points + '/' + attempt.maxPoints}
                tone={attempt.points === null ? 'amber' : 'green'}/>}
              onPress={() => openAttempt(attempt.id)}/>))}</Card>}
      </Section>
      <Section title="Questions">
        <Card>{results.quiz.items.map((item, i) => {
          const stats = results.items.find((s) => s.itemId === item.id);
          return <Item key={item.id} title={'Q' + (i + 1) + ' · ' + item.type.replace('-', ' ')}
            detail={item.type === 'essay' && stats?.meanPoints != null ? 'Average ' + Math.round(stats.meanPoints * 10) / 10 + ' / ' + item.points
              : stats?.percentCorrect != null ? stats.percentCorrect + '% correct'
              : stats && stats.responses > 0 ? 'Waiting for grading' : 'No responses'}
            leading={<CheckCircle2 size={18} color={palette.teal}/>}/>;
        })}</Card>
      </Section>
    </>;
  }}</QueryState></Page>;
}

function answerText(question: QuizQuestion, response?: QuizResponse): string {
  if (!response) return 'No answer';
  const label = (id: string) => question.choices?.find((c) => c.id === id)?.text ?? id;
  switch (response.type) {
    case 'multiple-choice': return label(response.choiceId);
    case 'multiple-select': return response.choiceIds.map(label).join(', ');
    case 'true-false': return response.value ? 'True' : 'False';
    case 'numeric': return String(response.value);
    default: return response.text;
  }
}

function GradeAttempt({ client, offeringId, attempt, onDone }: {
  client: DistrictClient; offeringId: string; attempt: StaffAttempt; onDone: () => void;
}) {
  const palette = usePalette();
  const styles = useStyles();
  const [current, setCurrent] = useState(attempt);
  const [points, setPoints] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answers = new Map(current.attempt.answers.map((a) => [a.itemId, a.response]));
  const scores = new Map((current.attempt.itemScores ?? []).map((s) => [s.itemId, s]));
  const save = (itemId: string, max: number) => {
    const value = Number(points[itemId]);
    if (!Number.isFinite(value) || value < 0 || value > max) { setError('Enter points from 0 to ' + max + '.'); return; }
    setBusy(itemId); setError(null);
    client.gradeQuizItem(offeringId, current.attempt.id, itemId, value, comments[itemId]?.trim() || undefined)
      .then(setCurrent, (e: unknown) => setError(e instanceof Error ? e.message : 'The grade did not save.')).finally(() => setBusy(null));
  };
  return <Page>
    <Title subtitle={current.quiz.title + ' · attempt ' + current.attempt.number}>{current.studentName}</Title>
    {error && <Text accessibilityRole="alert" style={{ color: palette.red, marginBottom: 12 }}>{error}</Text>}
    <View style={{ gap: 12 }}>{current.quiz.items.map((item, i) => {
      const score = scores.get(item.id);
      return <Card key={item.id} style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ color: palette.muted, fontWeight: '700' }}>Question {i + 1}</Text>
          <Chip label={score?.points == null ? 'Needs grading' : score.points + ' / ' + item.points} tone={score?.points == null ? 'amber' : 'green'}/>
        </View>
        <Markdown source={item.prompt}/>
        <Text style={{ color: palette.ink }}><Text style={{ fontWeight: '700' }}>Answer: </Text>{answerText(item, answers.get(item.id))}</Text>
        {item.type === 'essay' && <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <TextInput keyboardType="decimal-pad" accessibilityLabel={'Points for question ' + (i + 1)} placeholder={'0–' + item.points}
              placeholderTextColor={palette.subtle} value={points[item.id] ?? (score?.points != null ? String(score.points) : '')}
              onChangeText={(v) => setPoints((p) => ({ ...p, [item.id]: v }))} style={[styles.field, { width: 90 }]}/>
            <Text style={{ color: palette.muted }}>of {item.points}</Text>
          </View>
          <TextInput accessibilityLabel={'Comment for question ' + (i + 1)} placeholder="Comment for the student (optional)" multiline
            placeholderTextColor={palette.subtle} value={comments[item.id] ?? score?.comment ?? ''}
            onChangeText={(v) => setComments((c) => ({ ...c, [item.id]: v }))} style={[styles.field, { minHeight: 70, textAlignVertical: 'top' }]}/>
          <Button label={busy === item.id ? 'Saving…' : 'Save grade'} variant="outline" disabled={busy !== null || !(points[item.id] ?? '').trim()}
            onPress={() => save(item.id, item.points)}/>
        </View>}
      </Card>;
    })}</View>
    <View style={{ marginTop: 20 }}><Button label="Back to results" variant="outline" onPress={onDone}/></View>
  </Page>;
}

/** Due date and attempts for a teacher's assignment, edited in place. */
export function AssignmentSettings({ client, assignmentId, dueAt, attemptsAllowed, onSaved }: {
  client: DistrictClient; assignmentId: string; dueAt: string; attemptsAllowed: number; onSaved: () => void;
}) {
  const palette = usePalette();
  const [editing, setEditing] = useState(false);
  const [due, setDue] = useState(() => localInput(dueAt));
  const [attempts, setAttempts] = useState(String(attemptsAllowed));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shift = (days: number) => setDue((value) => {
    const base = parseLocal(value) ?? new Date(dueAt);
    return localInput(new Date(base.getTime() + days * 86_400_000).toISOString());
  });
  const save = () => {
    const date = parseLocal(due);
    const count = Number(attempts);
    if (!date) { setError('Use the form 2026-11-05 15:30.'); return; }
    if (!Number.isInteger(count) || count < 1 || count > 100) { setError('Attempts must be 1 to 100.'); return; }
    setBusy(true); setError(null);
    client.updateAssignment(assignmentId, { dueAt: date.toISOString(), attemptsAllowed: count })
      .then(() => { setEditing(false); onSaved(); }, (e: unknown) => setError(e instanceof Error ? e.message : 'The change did not save.'))
      .finally(() => setBusy(false));
  };
  if (!editing) {
    return <Card style={{ marginBottom: 22 }}><Item title={'Due ' + dateLabel(dueAt, true)} detail={attemptsAllowed + (attemptsAllowed === 1 ? ' attempt' : ' attempts') + ' allowed'}
      trailing={<Text style={{ color: palette.primary, fontWeight: '700' }}>Change</Text>} onPress={() => setEditing(true)}/></Card>;
  }
  return <Card style={{ gap: 12, marginBottom: 22 }}>
    <Field label="Due (your time)" value={due} onChangeText={setDue} placeholder="2026-11-05 15:30"/>
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ flex: 1 }}><Button label="+1 day" variant="outline" onPress={() => shift(1)}/></View>
      <View style={{ flex: 1 }}><Button label="+1 week" variant="outline" onPress={() => shift(7)}/></View>
    </View>
    <Field label="Attempts allowed" value={attempts} onChangeText={setAttempts} keyboardType="numeric"/>
    {error && <Text accessibilityRole="alert" style={{ color: palette.red }}>{error}</Text>}
    <Button label={busy ? 'Saving…' : 'Save changes'} disabled={busy} onPress={save}/>
    <Button label="Cancel" variant="quiet" onPress={() => setEditing(false)}/>
  </Card>;
}
