import { useRef, useState } from 'react';
import { Alert, Text, View, type ScrollViewInstance } from 'react-native';
import { GraduationCap } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Detail } from '../types';
import { useLoad, useReloadOnFocus } from '../hooks/useLoad';
import { useAppState } from '../state/app-state';
import { Markdown } from '../ui/Markdown';
import { AssignmentActions, StarterMaterials } from './AssignmentWork';
import { ActivityWork, YoungActivity, loadActivityWork } from './ActivityWork';
import { handInStatus, workSteps } from '../activity.ts';
import { isYoungLearnerBand } from '../gradeBand.ts';
import { usePalette } from '../ui/theme-context';
import { Button, Card, Chip, dateLabel, Item, Page, QueryState, ScrollLock, Section, Title } from '../ui/Primitives';


/** Never renders staff-only fields or answer keys; the district returns a student-filtered activity view. */
export function AssignmentScreen({ client, assignmentId, offeringId, navigate }: {
  client: DistrictClient; assignmentId: string; offeringId: string; navigate: (d: Detail) => void;
}) {
  const palette = usePalette();
  const [result, reload] = useLoad('assignment:' + assignmentId, async () => {
    const [details, submissions, grades] = await Promise.all([
      client.studentAssignment(assignmentId), client.studentSubmissions(assignmentId),
      client.studentOfficialGrades(assignmentId).catch(() => []),
    ]);
    const offering = offeringId || details.assignment.offeringId;
    const [activity, feedback, quizzes] = await Promise.all([
      client.studentActivity(details.assignment.activityId).catch(() => null),
      client.studentAssignmentFeedback(assignmentId).catch(() => []),
      client.studentQuizzes(offering).catch(() => []),
    ]);
    // Each step's saved work, when the activity asks for any; a failure here fails the page, so a
    // student never starts over on top of work they already saved.
    const work = !activity ? null : workSteps(activity.content).length > 0
      ? await loadActivityWork(client, offering, details.assignment, activity.content)
      : { saved: new Map(), workspaceId: null, readOnly: false };
    return { details, submissions, grades, activity, work, feedback, offering, quiz: quizzes.find((q) => q.assignmentId === assignmentId) ?? null };
  });
  const scroll = useRef<ScrollViewInstance>(null);
  const [locked, setLocked] = useState(false);
  useReloadOnFocus(reload);
  const { session } = useAppState();
  const [withdrawing, setWithdrawing] = useState(false);
  const withdraw = (submissionId: string) => Alert.alert('Withdraw this submission?',
    'Your teacher will no longer see it as submitted. You can submit again if attempts remain.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Withdraw', style: 'destructive', onPress: () => {
        setWithdrawing(true);
        client.withdrawSubmission(submissionId).then(reload, (e: unknown) =>
          Alert.alert("Couldn't withdraw", e instanceof Error ? e.message : 'Try again.')).finally(() => setWithdrawing(false));
      } },
    ]);
  return <ScrollLock.Provider value={setLocked}><Page refresh={reload} scrollRef={scroll} scrollEnabled={!locked}>
    <QueryState state={result} retry={reload}>{({ details, submissions, grades, activity, work, feedback, offering, quiz }) => {
      const { assignment } = details;
      const content = activity?.content;
      const active = submissions.filter((x) => !x.withdrawnAt);
      const handIn = handInStatus(submissions, assignment.attemptsAllowed);
      const used = submissions.length >= assignment.attemptsAllowed;
      const schoolHost = session ? new URL(session.district.origin).host : 'your school';
      const workProps = content && work ? {
        client, offeringId: offering, assignment, content, data: work, canSubmit: !used,
        attemptsLeft: Math.max(0, assignment.attemptsAllowed - submissions.length), schoolHost, onSubmitted: reload,
      } : null;

      const record = <>
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
        {feedback.length > 0 && <Section title={content && isYoungLearnerBand(content.gradeBand) ? 'What your teacher said' : 'Teacher feedback'}>
          <Card style={{ gap: 14 }}>{feedback.flatMap((record) => record.comments).map((comment, i) =>
            <Markdown key={i} source={comment.body}/>)}
          </Card>
        </Section>}
        {active.length > 0 && <Button label={withdrawing ? 'Withdrawing…' : 'Withdraw my submission'} variant="danger"
          disabled={withdrawing} onPress={() => withdraw(active.at(-1)!.id)}/>}
      </>;
      const actions = <AssignmentActions offeringId={offering} quiz={quiz} activityMissing={!content}
        ai={session?.district.features?.ai !== false} schoolHost={schoolHost} navigate={navigate}/>;

      // Young learners (K-2): one step a screen, with the submission record on the finish screen.
      if (workProps && content && isYoungLearnerBand(content.gradeBand)) {
        return <>
          <Title subtitle={'Due ' + dateLabel(assignment.dueAt, true)}>{assignment.title}</Title>
          {quiz && actions}
          {details.starterMaterials && details.starterMaterials.length > 0 &&
            <StarterMaterials client={client} assignmentId={assignmentId} materials={details.starterMaterials}/>}
          <YoungActivity {...workProps} scrollToTop={() => scroll.current?.scrollTo({ y: 0, animated: false })}
            handIn={handIn} finish={<View style={{ marginTop: 8 }}>{record}</View>}/>
        </>;
      }
      return <>
        <Title subtitle={'Due ' + dateLabel(assignment.dueAt, true)}>{assignment.title}</Title>
        <View style={{ gap: 11, flexDirection: 'row', marginBottom: 24 }}>
          <Chip label={active.length > 0 ? 'Submitted' : 'Not submitted'} tone={active.length > 0 ? 'green' : 'amber'}/>
          <Chip label={submissions.length + '/' + assignment.attemptsAllowed + ' attempts'} tone="neutral"/>
        </View>
        {details.starterMaterials && details.starterMaterials.length > 0 &&
          <StarterMaterials client={client} assignmentId={assignmentId} materials={details.starterMaterials}/>}
        {actions}
        {workProps && <ActivityWork {...workProps}/>}
        {used && <Card style={{ marginBottom: 18 }}><Text style={{ color: palette.muted }}>You have used all {assignment.attemptsAllowed} attempts.</Text></Card>}
        {record}
        <View style={{ height: 24 }}/>
      </>;
    }}</QueryState>
  </Page></ScrollLock.Provider>;
}

export function StudentGrades({ client, navigate }: {
  client: DistrictClient; navigate: (d: Detail) => void;
}) {
  const palette = usePalette();
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
  const palette = usePalette();
  const [data, retry] = useLoad('announcements', () => client.studentAnnouncements());
  return <Page refresh={retry}>
    <Title subtitle="Official classroom messages from your teachers.">Announcements</Title>
    <QueryState state={data} retry={retry} empty={(v) => v.length === 0} emptyText="No new announcements.">
      {(list) => <View style={{ gap: 12 }}>{list.map(({ announcement, courseLabel }) =>
        <Card key={announcement.id} style={{ gap: 12 }}>
          <Text style={{ color: palette.primary, fontSize: 12, fontWeight: '700' }}>{courseLabel}</Text>
          <Text style={{ color: palette.ink, fontSize: 18, fontWeight: '800' }}>{announcement.title}</Text>
          <Text style={{ color: palette.muted, fontSize: 12 }}>{dateLabel(announcement.publishAt, true)}</Text>
          <Markdown source={announcement.body}/>
        </Card>)}</View>}
    </QueryState>
  </Page>;
}
