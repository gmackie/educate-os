import { useState } from 'react';
import { Alert, Image, Text, View } from 'react-native';
import { FileText, MessageSquareText } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Detail } from '../types';
import { Markdown } from '../ui/Markdown';
import { imageType } from '../media.ts';
import { useLoad, useReloadOnFocus } from '../hooks/useLoad';
import { AssignmentSettings } from './Teaching';
import { usePalette } from '../ui/theme-context';
import { Button, Card, Chip, dateLabel, Field, Item, Page, Placeholder, QueryState, Section, Title } from '../ui/Primitives';

export function TeacherAssignment({ client, assignmentId, offeringId, navigate }: {
  client: DistrictClient; assignmentId: string; offeringId: string; navigate: (d: Detail) => void;
}) {
  const palette = usePalette();
  const [data, reload] = useLoad('teacher-assignment:' + assignmentId, async () => {
    const [assignment, submissions, proposals] = await Promise.all([
      client.teacherAssignment(assignmentId),
      client.teacherSubmissions(assignmentId),
      client.gradeProposals(assignmentId).catch(() => []),
    ]);
    // A deep link may not name the class; the assignment does.
    const students = await client.teacherRoster(offeringId || assignment.assignment.offeringId).catch(() => []);
    const names = new Map(students.map((s) => [s.enrollment.principalId, s.displayName]));
    return { assignment, submissions, names, proposals: proposals.filter((p) => !p.approvedAsVersion && !p.declined && !p.expired) };
  });
  useReloadOnFocus(reload);
  const decide = (proposalId: string, approve: boolean) => {
    const done = () => reload();
    const fail = (e: unknown) => Alert.alert("Couldn't save", e instanceof Error ? e.message : 'Try again.');
    if (approve) { client.approveGrade(proposalId).then(done, fail); return; }
    Alert.alert('Decline this grade?', 'The person who proposed it sees your reason.', [
      { text: 'Cancel', style: 'cancel' },
      ...['The score needs another look', 'It is for the wrong submission'].map((reason) => ({
        text: reason, onPress: () => { client.declineGrade(proposalId, reason).then(done, fail); },
      })),
    ]);
  };
  return <Page refresh={reload}>
    <QueryState state={data} retry={reload}>{({ assignment, submissions, names, proposals }) => <>
      <Title>{assignment.assignment.title}</Title>
      <AssignmentSettings client={client} assignmentId={assignmentId} dueAt={assignment.assignment.dueAt}
        attemptsAllowed={assignment.assignment.attemptsAllowed} onSaved={reload}/>
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 26 }}>
        <Card style={{ flex: 1, alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 27, fontWeight: '800', color: palette.primary }}>{submissions.length}</Text>
          <Text style={{ fontSize: 12, color: palette.muted }}>Submissions</Text>
        </Card>
        <Card style={{ flex: 1, alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 27, fontWeight: '800', color: palette.ink }}>{names.size}</Text>
          <Text style={{ fontSize: 12, color: palette.muted }}>Enrolled</Text>
        </Card>
      </View>
      {proposals.length > 0 && <Section title="Grades waiting for approval">
        <Card>{proposals.map((p) => <View key={p.id} style={{ gap: 8, paddingVertical: 8 }}>
          <Text style={{ color: palette.ink, fontWeight: '700' }}>{(names.get(p.studentPrincipalId) ?? 'Student') + ': ' + p.score.points + ' / ' + p.score.maxPoints}</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Button label="Approve" variant="outline" onPress={() => decide(p.id, true)}/></View>
            <View style={{ flex: 1 }}><Button label="Decline" variant="quiet" onPress={() => decide(p.id, false)}/></View>
          </View>
        </View>)}</Card>
      </Section>}
      <Section title="Review student work">
        {submissions.length === 0 ? <Placeholder title="No submissions yet"
          message="Student submissions will appear here when they turn in their work."/> :
          <Card>{submissions.filter((s) => !s.withdrawnAt).map((submission) => <Item key={submission.id}
            title={names.get(submission.studentPrincipalId) ?? 'Student'}
            detail={'Attempt ' + submission.attempt + ' · ' + dateLabel(submission.submittedAt, true)}
            leading={<FileText color={palette.primary} size={20}/>}
            onPress={() => navigate({
              type: 'teacher-review', id: submission.id, assignmentId,
              studentName: names.get(submission.studentPrincipalId) ?? 'Student',
              artifacts: submission.items.map((item) => ({ artifactId: item.artifactId, type: item.artifactType })),
            })}/>)}</Card>}
      </Section>
      <Card style={{ gap: 10, marginBottom: 25 }}>
        <Chip label="Staff only"/>
        <Text style={{ color: palette.muted, lineHeight: 20 }}>
          Comments and grades are visible to students only according to your school's release and approval policies.
        </Text>
      </Card>
    </>}</QueryState>
  </Page>;
}

export function TeacherReview({ client, submissionId, studentName, artifacts }: {
  client: DistrictClient; submissionId: string; studentName: string;
  artifacts: { artifactId: string; type: string }[];
}) {
  const palette = usePalette();
  const [comment, setComment] = useState('');
  const [points, setPoints] = useState('');
  const [maxPoints, setMaxPoints] = useState('100');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [data, reload] = useLoad('teacher-review:' + submissionId, async () => {
    const [feedback, content] = await Promise.all([
      client.teacherFeedback(submissionId),
      Promise.all(artifacts.map((a) => client.teacherSubmittedContent(submissionId, a.artifactId)
        .then((item) => ({ ...item, type: a.type }))
        .catch(() => ({ title: a.type, type: a.type, content: { kind: 'unavailable' } as { kind: string; text?: string; base64?: string } })))),
    ]);
    return { feedback, content };
  });

  const save = async (job: 'comment' | 'grade' | 'release' | 'final') => {
    if (busy) return;
    if (job === 'comment' && comment.trim().length < 1) return;
    if (job === 'grade') {
      const score = Number(points), max = Number(maxPoints);
      if (!Number.isFinite(score) || !Number.isFinite(max) || score < 0 || max <= 0 ||
          score > max || max > 100000) {
        Alert.alert('Check score', 'Enter a valid score between zero and the maximum.');
        return;
      }
    }
    setBusy(true); setMessage(null);
    try {
      if (job === 'comment') {
        await client.teacherComment(submissionId, comment.trim());
        setComment(''); setMessage('Comment saved for staff review.');
      } else if (job === 'grade') {
        const result = await client.teacherRecordGrade(submissionId, Number(points), Number(maxPoints));
        setMessage(result.status === 'pending-approval' ? 'Grade proposed. It is awaiting approval.' :
          'Official grade recorded.');
      } else {
        await client.teacherReleaseFeedback(submissionId, job === 'final' ? 'final' : 'shared-with-student');
        setMessage(job === 'final' ? 'Feedback marked final and shared with the student.' : 'Feedback released to the student.');
      }
      reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The school could not save this action.');
    } finally { setBusy(false); }
  };
  return <Page refresh={reload}>
    <Title subtitle="Only actions allowed by your school's assessment policies will complete.">
      Review: {studentName}
    </Title>
    {message && <Card style={{ marginBottom: 18 }}>
      <Text accessibilityRole="alert" style={{ color: palette.ink, lineHeight: 21 }}>{message}</Text>
    </Card>}
    <QueryState state={data} retry={reload}>{({ feedback, content }) => <>
      <Section title="Submitted work">
        <Card style={{ gap: 15 }}>
          {content.length === 0 ? <Text style={{ color: palette.muted }}>No readable artifacts attached.</Text> :
            content.map((item, index) => <View key={index} style={{ gap: 9 }}>
              <Text style={{ fontSize: 14, color: palette.primary, fontWeight: '800' }}>
                {item.title || 'Submitted ' + item.type}
              </Text>
              {item.content.kind === 'text' && typeof item.content.text === 'string' ?
                <Text selectable style={{ fontSize: 15, color: palette.ink, lineHeight: 24 }}>{item.content.text}</Text> :
                item.content.kind === 'bytes' && item.content.base64 && imageType(item.content.base64) ?
                  <Image accessibilityLabel={'Submitted ' + item.type} resizeMode="contain"
                    source={{ uri: 'data:' + imageType(item.content.base64) + ';base64,' + item.content.base64 }}
                    style={{ width: '100%', height: 320, borderRadius: 12, backgroundColor: palette.background }}/> :
                <Text style={{ color: palette.muted, lineHeight: 20 }}>
                  Open this file on a computer to see it.
                </Text>}
            </View>)}
        </Card>
      </Section>
      <View style={{ marginBottom: 20 }}><Chip label={feedback.state ?? 'Not released'}
        tone={feedback.state === 'final' ? 'green' : 'amber'}/></View>
      <Section title="Existing comments">
        <Card>{feedback.comments.length === 0 ? <Text style={{ color: palette.muted }}>No comments yet.</Text> :
          feedback.comments.map((item, index) => <View key={index} style={{ marginBottom: 10 }}><Markdown source={item.body}/></View>)}
        </Card>
      </Section>
      <Section title="Add feedback">
        <Card style={{ gap: 13 }}>
          <Field label="Your comment" value={comment} onChangeText={setComment}
            placeholder="Give clear, specific feedback…" multiline/>
          <Button label={busy ? 'Saving…' : 'Save comment'} disabled={busy || !comment.trim()}
            icon={<MessageSquareText color={palette.onPrimary} size={17}/>}
            onPress={() => void save('comment')}/>
        </Card>
      </Section>
      <Section title="Record official grade">
        <Card style={{ gap: 14 }}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Field label="Points" value={points} onChangeText={setPoints}
                keyboardType="numeric" placeholder="0"/>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Out of" value={maxPoints} onChangeText={setMaxPoints}
                keyboardType="numeric" placeholder="100"/>
            </View>
          </View>
          <Text style={{ color: palette.muted, fontSize: 12, lineHeight: 19 }}>
            Your district may require approval before the grade becomes official.
          </Text>
          <Button label="Record grade" variant="outline" disabled={busy || !points.trim()}
            onPress={() => Alert.alert('Record grade?', 'This may become a permanent official grade.', [
              { text: 'Cancel', style: 'cancel' }, { text: 'Record', onPress: () => { void save('grade'); } },
            ])}/>
        </Card>
      </Section>
      <Section title="Share feedback">
        <View style={{ gap: 10 }}>
          <Button label="Release comments to student" disabled={busy || feedback.state === 'final' || feedback.state === 'shared-with-student'}
            onPress={() => Alert.alert('Release feedback?', 'Your comments will become visible to this student, subject to district policy.', [
              { text: 'Cancel', style: 'cancel' }, { text: 'Release', onPress: () => { void save('release'); } },
            ])}/>
          <Button label="Mark feedback final" variant="outline" disabled={busy || feedback.state === 'final'}
            onPress={() => Alert.alert('Mark feedback final?', 'The student sees it, and it can no longer be changed.', [
              { text: 'Cancel', style: 'cancel' }, { text: 'Mark final', onPress: () => { void save('final'); } },
            ])}/>
        </View>
      </Section>
    </>}</QueryState>
  </Page>;
}

/** The Review tab: recent assignments across a teacher's classes, with work waiting to be seen. */
export function ReviewQueue({ client, navigate }: { client: DistrictClient; navigate: (d: Detail) => void }) {
  const palette = usePalette();
  const [state, reload] = useLoad('review-queue', async () => {
    const classes = await client.teacherClasses();
    const perClass = await Promise.all(classes.slice(0, 12).map(async (course) => {
      const assignments = await client.teacherAssignments(course.offering.id).catch(() => []);
      return assignments.map((assignment) => ({ assignment, course }));
    }));
    const recent = perClass.flat()
      .toSorted((a, b) => Date.parse(b.assignment.dueAt) - Date.parse(a.assignment.dueAt))
      .slice(0, 15);
    return Promise.all(recent.map(async (entry) => ({
      ...entry,
      submitted: (await client.teacherSubmissions(entry.assignment.id).catch(() => []))
        .filter((s) => !s.withdrawnAt).length,
    })));
  });
  return <Page refresh={reload}>
    <Title subtitle="Recent assignments and the work your students have turned in.">Review</Title>
    <QueryState state={state} retry={reload} empty={(v) => v.length === 0}
      emptyText="Assignments you publish will appear here for review.">
      {(items) => <Card>{items.map(({ assignment, course, submitted }) => <Item key={assignment.id}
        title={assignment.title}
        detail={course.course.title + ' · due ' + dateLabel(assignment.dueAt)}
        leading={<FileText color={palette.primary} size={20}/>}
        trailing={<Chip label={submitted + ' submitted'} tone={submitted > 0 ? 'blue' : 'neutral'}/>}
        onPress={() => navigate({ type: 'teacher-assignment', id: assignment.id, offeringId: assignment.offeringId })}/>)}</Card>}
    </QueryState>
  </Page>;
}
