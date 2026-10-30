import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { CheckCircle2, Circle, ClipboardList, FileText, Flag, Megaphone, MessagesSquare, PenLine, Pin, Square, SquareCheck } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type {
  Activity, Announcement, CourseOutline, Detail, DiscussionPost, DiscussionThread, QuizAnswer, QuizAttempt, QuizQuestion,
  QuizResponse, QuizResult, QuizSummary, TopicListing,
} from '../types';
import { useLoad } from '../hooks/useLoad';
import { usePalette } from '../ui/theme-context';
import { Markdown, plainText } from '../ui/Markdown';
import { Button, Card, Chip, dateLabel, Item, Page, Placeholder, QueryState, Section, Title, useStyles } from '../ui/Primitives';

type Role = 'student' | 'teacher';

/** What a class has besides its assignments, each part on its own so one failing route hides only itself. */
export type CourseExtras = {
  outline: CourseOutline['outline'] | null; announcements: Announcement[];
  discussions: TopicListing | null; quizzes: QuizSummary[];
};

export async function loadStudentExtras(client: DistrictClient, offeringId: string): Promise<CourseExtras> {
  const [modules, announcements, discussions, quizzes] = await Promise.all([
    client.studentModules(offeringId).catch(() => null),
    client.studentCourseAnnouncements(offeringId).catch(() => []),
    client.discussions('student', offeringId).catch(() => null),
    client.studentQuizzes(offeringId).catch(() => []),
  ]);
  return { outline: modules?.outline ?? null, announcements, discussions, quizzes };
}

/** A class's announcements, modules, quizzes and discussions, for its student page. */
export function CourseSections({ offeringId, extras, activities, navigate }: {
  offeringId: string; extras: CourseExtras; activities: Activity[]; navigate: (d: Detail) => void;
}) {
  const palette = usePalette();
  const [openAnnouncement, setOpenAnnouncement] = useState<string | null>(null);
  const pages = new Map((extras.outline?.pages ?? []).map((p) => [p.id, p]));
  const byActivity = new Map(activities.map((a) => [a.assignment.activityId, a.assignment]));
  const modules = (extras.outline?.modules ?? []).filter((m) => m.published && m.items.length > 0);
  return <>
    {extras.announcements.length > 0 && <Section title="Announcements">
      <Card>{extras.announcements.slice(0, 5).map(({ announcement }) => <View key={announcement.id}>
        <Item title={announcement.title} detail={dateLabel(announcement.publishAt)}
          leading={<Megaphone size={19} color={palette.teal}/>}
          onPress={() => setOpenAnnouncement(openAnnouncement === announcement.id ? null : announcement.id)}/>
        {openAnnouncement === announcement.id && <View style={{ paddingBottom: 12, paddingLeft: 4 }}>
          <Markdown source={announcement.body}/></View>}
      </View>)}</Card>
    </Section>}

    {modules.length > 0 && <Section title="Modules">
      <View style={{ gap: 12 }}>{modules.map((module) => <Card key={module.id}>
        <Text accessibilityRole="header" style={{ color: palette.ink, fontWeight: '800', fontSize: 16, marginBottom: 4 }}>{module.title}</Text>
        {module.items.map((item) => {
          if (item.kind === 'page') {
            const page = pages.get(item.pageId);
            return page && <Item key={item.id} title={page.title} detail="Page"
              leading={<FileText size={19} color={palette.primary}/>}
              onPress={() => navigate({ type: 'page', offeringId, pageId: page.id })}/>;
          }
          const assignment = byActivity.get(item.activityId);
          return assignment && <Item key={item.id} title={assignment.title} detail={'Due ' + dateLabel(assignment.dueAt, true)}
            leading={<ClipboardList size={19} color={palette.primary}/>}
            onPress={() => navigate({ type: 'assignment', id: assignment.id, offeringId })}/>;
        })}
      </Card>)}</View>
    </Section>}

    {extras.quizzes.length > 0 && <Section title="Quizzes">
      <Card>{extras.quizzes.map((quiz) => <Item key={quiz.id} title={quiz.title} detail={quizDetail(quiz)}
        leading={<PenLine size={19} color={palette.primary}/>}
        onPress={() => navigate({ type: 'quiz', offeringId, quizId: quiz.id })}/>)}</Card>
    </Section>}

    {extras.discussions && extras.discussions.topics.length > 0 && <Section title="Discussions">
      <Card>{extras.discussions.topics.map(({ topic, posts }) => <Item key={topic.id} title={topic.title}
        detail={posts === 1 ? '1 post' : posts + ' posts'}
        leading={topic.pinned ? <Pin size={19} color={palette.primary}/> : <MessagesSquare size={19} color={palette.primary}/>}
        onPress={() => navigate({ type: 'discussion', offeringId, topicId: topic.id })}/>)}</Card>
    </Section>}
  </>;
}

function quizDetail(quiz: QuizSummary): string {
  if (quiz.releasedScore) return 'Score ' + quiz.releasedScore.points + ' / ' + quiz.releasedScore.maxPoints;
  if (quiz.attempts.some((a) => a.status === 'in-progress')) return 'In progress';
  if (quiz.availability === 'upcoming') return 'Opens ' + (quiz.availableFrom ? dateLabel(quiz.availableFrom, true) : 'soon');
  if (quiz.availability === 'closed') return 'Closed';
  const used = quiz.attempts.filter((a) => a.status !== 'in-progress').length;
  return used > 0 ? 'Submitted · ' + used + ' of ' + quiz.attemptsAllowed + ' attempts' : quiz.questionCount + ' questions · ' + quiz.totalPoints + ' points';
}

/** `/class/<offering>/page/<page>`: one module page. */
export function PageScreen({ client, offeringId, pageId, role }: { client: DistrictClient; offeringId: string; pageId: string; role: Role }) {
  const [state, reload] = useLoad('page:' + offeringId + ':' + pageId, async () => {
    const outline = role === 'teacher' ? await client.teacherModules(offeringId) : await client.studentModules(offeringId);
    const page = outline.outline.pages.find((p) => p.id === pageId);
    if (!page) throw new Error('This page is no longer in the class.');
    return page;
  });
  return <Page refresh={reload}><QueryState state={state} retry={reload}>{(page) => <>
    <Title>{page.title}</Title>
    <Card><Markdown source={page.body}/></Card>
  </>}</QueryState></Page>;
}

/** `/class/<offering>/discussion/<topic>`: a topic's thread, with replies under the post they answer. */
export function DiscussionScreen({ client, offeringId, topicId, role }: {
  client: DistrictClient; offeringId: string; topicId: string; role: Role;
}) {
  const palette = usePalette();
  const styles = useStyles();
  const [state, reload] = useLoad('thread:' + offeringId + ':' + topicId, () => client.discussionThread(role, offeringId, topicId));
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<DiscussionPost | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const post = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true); setMessage(null);
    try {
      const created = await client.createPost(role, offeringId, topicId, draft.trim(), replyTo?.id);
      setDraft(''); setReplyTo(null);
      if (created.status === 'pending') setMessage('Posted. Your teacher will check it before others see it.');
      reload();
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Your post could not be sent.'); } finally { setBusy(false); }
  };
  const report = (target: DiscussionPost) => {
    Alert.alert('Report this post?', 'Your teacher will see the report. The writer will not know who sent it.', [
      { text: 'Cancel', style: 'cancel' },
      ...(['unkind', 'unsafe', 'off-topic'] as const).map((reason) => ({ text: reason === 'off-topic' ? 'Off topic' : reason[0]!.toUpperCase() + reason.slice(1),
        onPress: () => { void client.reportPost(offeringId, target.id, reason).then(() => setMessage('Thanks. Your teacher will take a look.'),
          (e: unknown) => setMessage(e instanceof Error ? e.message : 'The report could not be sent.')); } })),
    ]);
  };

  return <Page refresh={reload}><QueryState state={state} retry={reload}>{(thread) => {
    const names = new Map(thread.authors.map((a) => [a.principalId, a.displayName]));
    const roots = thread.posts.filter((p) => !p.parentId);
    const replies = (id: string) => thread.posts.filter((p) => p.parentId === id);
    const closed = thread.topic.locked;
    return <>
      <Title>{thread.topic.title}</Title>
      <Card style={{ marginBottom: 22 }}><Markdown source={thread.topic.prompt}/></Card>
      {message && <Text accessibilityRole="alert" style={{ color: palette.muted, marginBottom: 14 }}>{message}</Text>}
      {!closed && <View style={{ gap: 10, marginBottom: 24 }}>
        {replyTo && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: palette.muted, flex: 1 }} numberOfLines={1}>Replying to {postAuthor(replyTo, names)}</Text>
          <Pressable accessibilityRole="button" onPress={() => setReplyTo(null)}><Text style={{ color: palette.primary, fontWeight: '700' }}>Cancel</Text></Pressable>
        </View>}
        <TextInput value={draft} onChangeText={setDraft} multiline placeholder={replyTo ? 'Write a reply…' : 'Add to the discussion…'}
          placeholderTextColor={palette.subtle} style={[styles.field, { minHeight: 90, textAlignVertical: 'top' }]}
          accessibilityLabel={replyTo ? 'Reply' : 'New post'}/>
        <Button label={busy ? 'Posting…' : 'Post'} disabled={busy || !draft.trim()} onPress={() => { void post(); }}/>
      </View>}
      {closed && <Placeholder title="This discussion is closed" message="Your teacher has locked it, so no one can post."/>}
      <Section title={thread.posts.length === 1 ? '1 post' : thread.posts.length + ' posts'}>
        {roots.length === 0 ? <Placeholder title="No posts yet" message="Be the first to respond."/> :
          <View style={{ gap: 12 }}>{roots.map((root) => <Card key={root.id}>
            <PostView post={root} names={names} onReply={!closed && thread.topic.settings.allowReplies ? setReplyTo : undefined}
              onReport={role === 'student' ? report : undefined}/>
            {replies(root.id).map((reply) => <View key={reply.id} style={{ marginLeft: 16, marginTop: 12, paddingLeft: 12,
              borderLeftWidth: 2, borderColor: palette.line }}>
              <PostView post={reply} names={names} onReport={role === 'student' ? report : undefined}/>
            </View>)}
          </Card>)}</View>}
      </Section>
    </>;
  }}</QueryState></Page>;
}

function postAuthor(post: DiscussionPost, names: Map<string, string>): string {
  if (post.status === 'withdrawn') return 'a removed post';
  return post.mine ? 'You' : names.get(post.authorId) ?? (post.authorRole === 'staff' ? 'Teacher' : 'Classmate');
}

function PostView({ post, names, onReply, onReport }: {
  post: DiscussionPost; names: Map<string, string>; onReply?: (p: DiscussionPost) => void; onReport?: (p: DiscussionPost) => void;
}) {
  const palette = usePalette();
  if (post.status === 'withdrawn') return <Text style={{ color: palette.subtle, fontStyle: 'italic' }}>This post was removed.</Text>;
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={{ color: palette.ink, fontWeight: '800', flex: 1 }}>{postAuthor(post, names)}</Text>
      {post.authorRole === 'staff' && <Chip label="Teacher"/>}
      {post.status === 'pending' && <Chip label="Waiting for teacher" tone="amber"/>}
      <Text style={{ color: palette.subtle, fontSize: 12 }}>{dateLabel(post.createdAt)}</Text>
    </View>
    <Markdown source={post.body}/>
    <View style={{ flexDirection: 'row', gap: 18 }}>
      {onReply && <Pressable accessibilityRole="button" accessibilityLabel={'Reply to ' + postAuthor(post, names)} onPress={() => onReply(post)}>
        <Text style={{ color: palette.primary, fontWeight: '700' }}>Reply</Text></Pressable>}
      {onReport && !post.mine && <Pressable accessibilityRole="button" accessibilityLabel="Report post" onPress={() => onReport(post)}
        style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
        <Flag size={13} color={palette.subtle}/><Text style={{ color: palette.subtle }}>Report</Text></Pressable>}
    </View>
  </View>;
}

type QuizMode = { kind: 'overview' } | { kind: 'taking'; attempt: QuizAttempt } | { kind: 'result'; result: QuizResult };

/** `/class/<offering>/quiz/<quiz>`: start or resume an attempt, answer (saved as you go), submit, see results. */
export function QuizScreen({ client, offeringId, quizId }: { client: DistrictClient; offeringId: string; quizId: string }) {
  const palette = usePalette();
  const [state, reload] = useLoad('quiz:' + offeringId + ':' + quizId, () => client.studentQuiz(offeringId, quizId));
  const [mode, setMode] = useState<QuizMode>({ kind: 'overview' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (work: () => Promise<QuizMode>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { setMode(await work()); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work. Try again.'); } finally { setBusy(false); }
  };
  const back = () => { setMode({ kind: 'overview' }); reload(); };

  if (mode.kind === 'taking') {
    return <QuizRunner client={client} offeringId={offeringId} attempt={mode.attempt}
      onSubmitted={(result) => setMode({ kind: 'result', result })} onLeave={back}/>;
  }
  if (mode.kind === 'result') return <QuizResultView result={mode.result} onBack={back}/>;

  return <Page refresh={reload}><QueryState state={state} retry={reload}>{(quiz) => {
    const open = quiz.attempts.find((a) => a.status === 'in-progress');
    const finished = quiz.attempts.filter((a) => a.status !== 'in-progress');
    return <>
      <Title subtitle={quiz.courseTitle}>{quiz.title}</Title>
      {quiz.description ? <Card style={{ marginBottom: 18 }}><Markdown source={quiz.description}/></Card> : null}
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 22 }}>
        <Card style={{ flex: 1, alignItems: 'center', gap: 4 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: palette.primary }}>{quiz.questionCount}</Text>
          <Text style={{ fontSize: 12, color: palette.muted }}>Questions</Text></Card>
        <Card style={{ flex: 1, alignItems: 'center', gap: 4 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: palette.ink }}>
            {quiz.releasedScore ? quiz.releasedScore.points + '/' + quiz.releasedScore.maxPoints : quiz.totalPoints}</Text>
          <Text style={{ fontSize: 12, color: palette.muted }}>{quiz.releasedScore ? 'Your score' : 'Points'}</Text></Card>
        <Card style={{ flex: 1, alignItems: 'center', gap: 4 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: palette.ink }}>{finished.length}/{quiz.attemptsAllowed}</Text>
          <Text style={{ fontSize: 12, color: palette.muted }}>Attempts</Text></Card>
      </View>
      {quiz.timeLimitMinutes && <Text style={{ color: palette.muted, marginBottom: 12 }}>Time limit: {quiz.timeLimitMinutes} minutes, once you start.</Text>}
      {quiz.availableUntil && <Text style={{ color: palette.muted, marginBottom: 12 }}>Closes {dateLabel(quiz.availableUntil, true)}.</Text>}
      {error && <Text accessibilityRole="alert" style={{ color: palette.red, marginBottom: 12 }}>{error}</Text>}
      <View style={{ gap: 10, marginBottom: 24 }}>
        {open ? <Button label={busy ? 'Opening…' : 'Resume attempt ' + open.number} disabled={busy}
          onPress={() => { void act(async () => ({ kind: 'taking', attempt: await client.quizAttempt(offeringId, open.id) })); }}/>
          : quiz.canStart ? <Button label={busy ? 'Starting…' : finished.length > 0 ? 'Try again' : 'Start quiz'} disabled={busy}
            onPress={() => { void act(async () => ({ kind: 'taking', attempt: await client.startQuizAttempt(offeringId, quizId) })); }}/>
            : <Placeholder title={quiz.availability === 'upcoming' ? 'Not open yet' : finished.length >= quiz.attemptsAllowed ? 'No attempts left' : 'Closed'}
              message={quiz.availability === 'upcoming' ? 'Your teacher will open this quiz soon.' : "You can't start another attempt."}/>}
      </View>
      {finished.length > 0 && <Section title="Your attempts">
        <Card>{finished.map((attempt) => <Item key={attempt.id} title={'Attempt ' + attempt.number}
          detail={(attempt.status === 'expired' ? 'Time ran out' : 'Submitted') + (attempt.submittedAt ? ' · ' + dateLabel(attempt.submittedAt, true) : '')}
          leading={<CheckCircle2 size={19} color={palette.teal}/>}
          onPress={() => { void act(async () => ({ kind: 'result', result: await client.quizResult(offeringId, attempt.id) })); }}/>)}</Card>
      </Section>}
    </>;
  }}</QueryState></Page>;
}

function QuizRunner({ client, offeringId, attempt, onSubmitted, onLeave }: {
  client: DistrictClient; offeringId: string; attempt: QuizAttempt; onSubmitted: (r: QuizResult) => void; onLeave: () => void;
}) {
  const palette = usePalette();
  const [answers, setAnswers] = useState<Map<string, QuizResponse>>(() => new Map(attempt.answers.map((a) => [a.itemId, a.response])));
  const [saved, setSaved] = useState<string | null>(attempt.savedAt ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const list = useCallback((m: Map<string, QuizResponse>): QuizAnswer[] => [...m].map(([itemId, response]) => ({ itemId, response })), []);
  // Time left, counted from the server's clock rather than the phone's.
  const skew = Date.parse(attempt.serverNow) - Date.now();
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    if (!attempt.deadline) return;
    const timer = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(timer);
  }, [attempt.deadline, skew]);

  // Saved a moment after each change, so leaving the screen loses nothing.
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => {
      dirty.current = false;
      client.saveQuizAnswers(offeringId, attempt.attemptId, list(answers))
        .then(() => setSaved(new Date().toISOString()), () => setError('Not saved yet. Check your connection.'));
    }, 1200);
    return () => clearTimeout(timer);
  }, [answers, client, offeringId, attempt.attemptId, list]);

  const set = (itemId: string, response: QuizResponse | null) => {
    dirty.current = true;
    setAnswers((current) => {
      const next = new Map(current);
      if (response === null) next.delete(itemId); else next.set(itemId, response);
      return next;
    });
  };
  const submit = () => {
    const missing = attempt.questions.length - answers.size;
    Alert.alert('Submit this attempt?', missing > 0 ? missing + ' question' + (missing === 1 ? ' is' : 's are') + ' unanswered.' : "You can't change your answers after this.", [
      { text: 'Keep working', style: 'cancel' },
      { text: 'Submit', onPress: () => {
        setBusy(true); setError(null);
        client.submitQuizAttempt(offeringId, attempt.attemptId, list(answers)).then(onSubmitted,
          (e: unknown) => setError(e instanceof Error ? e.message : 'The attempt could not be submitted.')).finally(() => setBusy(false));
      } },
    ]);
  };
  const remaining = attempt.deadline ? Math.max(0, Date.parse(attempt.deadline) - now) : null;

  return <Page>
    <Title subtitle={'Attempt ' + attempt.number + (saved ? ' · Saved ' + dateLabel(saved, true) : '')}>{attempt.title}</Title>
    {remaining !== null && <Chip label={remaining === 0 ? 'Time is up' : Math.floor(remaining / 60_000) + ':' + String(Math.floor(remaining / 1000) % 60).padStart(2, '0') + ' left'}
      tone={remaining < 120_000 ? 'red' : 'amber'}/>}
    <View style={{ gap: 14, marginTop: 14 }}>{attempt.questions.map((question, index) =>
      <QuestionCard key={question.id} index={index} question={question} response={answers.get(question.id)}
        onChange={(response) => set(question.id, response)}/>)}</View>
    {error && <Text accessibilityRole="alert" style={{ color: palette.red, marginTop: 14 }}>{error}</Text>}
    <View style={{ gap: 10, marginTop: 22 }}>
      <Button label={busy ? 'Submitting…' : 'Submit'} disabled={busy} onPress={submit}/>
      <Button label="Save and leave" variant="quiet" onPress={() => {
        void client.saveQuizAnswers(offeringId, attempt.attemptId, list(answers)).catch(() => {}).finally(onLeave);
      }}/>
    </View>
  </Page>;
}

function QuestionCard({ index, question, response, onChange }: {
  index: number; question: QuizQuestion; response?: QuizResponse; onChange: (r: QuizResponse | null) => void;
}) {
  const palette = usePalette();
  const styles = useStyles();
  const choice = (selected: boolean, label: string, onPress: () => void, multi = false) => {
    const Icon = multi ? (selected ? SquareCheck : Square) : (selected ? CheckCircle2 : Circle);
    return <Pressable key={label} onPress={onPress} accessibilityRole={multi ? 'checkbox' : 'radio'} accessibilityState={{ checked: selected }}
      accessibilityLabel={label} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12,
        borderRadius: 12, borderWidth: 1, borderColor: selected ? palette.primary : palette.line,
        backgroundColor: selected ? palette.primarySoft : palette.raised }}>
      <Icon size={20} color={selected ? palette.primary : palette.subtle}/>
      <Text style={{ color: palette.ink, flex: 1, fontSize: 15 }}>{label}</Text>
    </Pressable>;
  };
  const text = response && 'text' in response ? response.text : '';
  return <Card style={{ gap: 12 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
      <Text style={{ color: palette.muted, fontWeight: '700' }}>Question {index + 1}</Text>
      <Text style={{ color: palette.subtle }}>{question.points} {question.points === 1 ? 'point' : 'points'}</Text>
    </View>
    <Markdown source={question.prompt} size={16}/>
    {question.type === 'multiple-choice' && (question.choices ?? []).map((c) => choice(
      response?.type === 'multiple-choice' && response.choiceId === c.id, c.text, () => onChange({ type: 'multiple-choice', choiceId: c.id })))}
    {question.type === 'multiple-select' && (question.choices ?? []).map((c) => {
      const ids = response?.type === 'multiple-select' ? response.choiceIds : [];
      const on = ids.includes(c.id);
      return choice(on, c.text, () => {
        const next = on ? ids.filter((x) => x !== c.id) : [...ids, c.id];
        onChange(next.length > 0 ? { type: 'multiple-select', choiceIds: next } : null);
      }, true);
    })}
    {question.type === 'true-false' && [true, false].map((value) => choice(
      response?.type === 'true-false' && response.value === value, value ? 'True' : 'False', () => onChange({ type: 'true-false', value })))}
    {question.type === 'numeric' && <TextInput keyboardType="numbers-and-punctuation" returnKeyType="done" submitBehavior="blurAndSubmit" accessibilityLabel={'Answer to question ' + (index + 1)}
      defaultValue={response?.type === 'numeric' ? String(response.value) : ''} placeholder="Your answer" placeholderTextColor={palette.subtle}
      style={styles.field} onChangeText={(value) => {
        const n = Number(value.replace(',', '.'));
        onChange(value.trim() === '' || !Number.isFinite(n) ? null : { type: 'numeric', value: n });
      }}/>}
    {(question.type === 'short-answer' || question.type === 'essay') && <TextInput value={text} multiline={question.type === 'essay'}
      maxLength={question.maxLength} placeholder={question.type === 'essay' ? 'Write your answer…' : 'Your answer'} placeholderTextColor={palette.subtle}
      returnKeyType={question.type === 'essay' ? 'default' : 'done'} submitBehavior={question.type === 'essay' ? 'newline' : 'blurAndSubmit'}
      accessibilityLabel={'Answer to question ' + (index + 1)}
      style={[styles.field, question.type === 'essay' && { minHeight: 120, textAlignVertical: 'top' }]}
      onChangeText={(value) => onChange(value === '' ? null : { type: question.type as 'short-answer' | 'essay', text: value })}/>}
  </Card>;
}

function responseText(question: QuizQuestion, response?: QuizResponse): string {
  if (!response) return 'No answer';
  const label = (id: string) => question.choices?.find((c) => c.id === id)?.text ?? id;
  switch (response.type) {
    case 'multiple-choice': return label(response.choiceId);
    case 'multiple-select': return response.choiceIds.map(label).join(', ') || 'No answer';
    case 'true-false': return response.value ? 'True' : 'False';
    case 'numeric': return String(response.value);
    default: return response.text || 'No answer';
  }
}

function QuizResultView({ result, onBack }: { result: QuizResult; onBack: () => void }) {
  const palette = usePalette();
  return <Page>
    <Title subtitle={result.courseTitle + ' · Attempt ' + result.number}>{result.title}</Title>
    <Card style={{ gap: 6, marginBottom: 18 }}>
      <Text style={{ color: palette.ink, fontWeight: '800', fontSize: 17 }}>
        {result.status === 'expired' ? 'Time ran out' : 'Submitted'}{result.submittedAt ? ' ' + dateLabel(result.submittedAt, true) : ''}</Text>
      <Text style={{ color: palette.muted, lineHeight: 20 }}>{result.releasedScore
        ? 'Your score: ' + result.releasedScore.points + ' / ' + result.releasedScore.maxPoints
        : result.released ? 'Your teacher released scores for this quiz.' : 'Your teacher will release scores when everyone has finished.'}</Text>
    </Card>
    <View style={{ gap: 12 }}>{result.items.map((item, i) => <Card key={item.question.id} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
        <Text style={{ color: palette.muted, fontWeight: '700' }}>Question {i + 1}</Text>
        {result.answersShown && item.points !== undefined && <Chip label={item.points === null ? 'Being graded'
          : item.points + ' / ' + item.question.points} tone={item.points === null ? 'amber' : item.correct ? 'green' : 'neutral'}/>}
      </View>
      <Markdown source={item.question.prompt}/>
      <Text style={{ color: palette.ink }}><Text style={{ fontWeight: '700' }}>Your answer: </Text>{responseText(item.question, item.response)}</Text>
      {result.answersShown && item.correctResponse && !item.correct &&
        <Text style={{ color: palette.teal }}><Text style={{ fontWeight: '700' }}>Answer: </Text>{responseText(item.question, item.correctResponse)}</Text>}
      {result.answersShown && item.feedback && <Text style={{ color: palette.muted }}>{plainText(item.feedback)}</Text>}
      {result.answersShown && item.comment && <Text style={{ color: palette.muted }}><Text style={{ fontWeight: '700' }}>Teacher: </Text>{item.comment}</Text>}
    </Card>)}</View>
    <View style={{ marginTop: 22 }}><Button label="Back to the quiz" variant="outline" onPress={onBack}/></View>
  </Page>;
}
