import { useState } from 'react';
import { Text, View } from 'react-native';
import { BookOpen, ClipboardCheck, ClipboardList, FileText, GraduationCap, Users } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Assignment, ClassItem, Detail, GuardianChild, Principal } from '../types';
import { useLoad } from '../hooks/useLoad';
import { usePalette } from '../ui/theme-context';
import { Button, Card, Chip, dateLabel, Item, Page, Placeholder, QueryState, Section, Title } from '../ui/Primitives';

export function Classes({ client, me, navigate }: {
  client: DistrictClient; me: Principal; navigate: (d: Detail) => void;
}) {
  const palette = usePalette();
  const [state, reload] = useLoad('courses:' + me.principalId, async () => me.kind === 'guardian'
    ? await client.guardianChildren()
    : await (me.kind === 'student' ? client.studentClasses() : client.teacherClasses()));
  return <Page refresh={reload}>
    <Title subtitle={me.kind === 'guardian' ? "Your children's classwork and released grades." :
      me.kind === 'staff' ? 'Manage assignments and support your students.' : 'Lessons, activities, and your progress.'}>
      {me.kind === 'guardian' ? 'My children' : me.kind === 'staff' ? 'My classes' : 'Classes'}
    </Title>
    <QueryState state={state} retry={reload} empty={(value) => value.length === 0}
      emptyText="Your school hasn't added any classes here yet.">
      {(value) => <View style={{ gap: 12 }}>
        {me.kind === 'guardian' ? (value as GuardianChild[]).map((child) => <Card key={child.studentPrincipalId}>
          <Item title={child.displayName} detail="View current and past classes"
            leading={<Users size={21} color={palette.primary}/>}
            onPress={() => navigate({ type: 'family-child', id: child.studentPrincipalId })}/>
        </Card>) : (value as ClassItem[]).map((entry) => <Card key={entry.offering.id}>
          <View style={{ gap: 13 }}>
            <Chip label={entry.term?.state === 'closed' ? 'Finished term' : entry.term?.name || 'My class'}
              tone={entry.term?.state === 'closed' ? 'neutral' : 'green'}/>
            <Text style={{ color: palette.ink, fontSize: 19, fontWeight: '800' }}>{entry.course.title}</Text>
            <Text style={{ color: palette.muted }}>{entry.offering.sectionName}</Text>
            <Button label="Open class" variant="outline" onPress={() => navigate({
              type: me.kind === 'staff' ? 'teacher-class' : 'class', id: entry.offering.id,
            })}/>
          </View>
        </Card>)}
      </View>}
    </QueryState>
  </Page>;
}

export function StudentClass({ client, offeringId, navigate }: {
  client: DistrictClient; offeringId: string; navigate: (d: Detail) => void;
}) {
  const palette = usePalette();
  const [state, reload] = useLoad('student-class:' + offeringId, async () => {
    const [courses, activities, grades] = await Promise.all([
      client.studentClasses(), client.studentActivities(offeringId),
      client.studentGradeSummary(offeringId).catch(() => null),
    ]);
    return { course: courses.find((c) => c.offering.id === offeringId), activities, grades };
  });
  return <Page refresh={reload}>
    <QueryState state={state} retry={reload}>{(data) => <>
      <Title subtitle={data.course?.offering.sectionName}> {data.course?.course.title || 'Class'} </Title>
      <View style={{ gap: 12, flexDirection: 'row', marginBottom: 26 }}>
        <Card style={{ flex: 1, alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 24, fontWeight: '800', color: palette.primary }}>{data.activities.length}</Text>
          <Text style={{ fontSize: 12, color: palette.muted }}>Activities</Text>
        </Card>
        <Card style={{ flex: 1, alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 24, fontWeight: '800', color: palette.ink }}>
            {typeof data.grades?.row?.totals?.final === 'number' ? data.grades.row.totals.final.toFixed(1) + '%' : '—'}
          </Text>
          <Text style={{ fontSize: 12, color: palette.muted }}>Official grade</Text>
        </Card>
      </View>
      <Section title="Assignments">
        {data.activities.length === 0 ? <Placeholder title="No assignments" message="Your teacher hasn't published any activities yet."/> :
          <Card>{data.activities.map(({ assignment }) => <Item key={assignment.id} title={assignment.title}
            detail={'Due ' + dateLabel(assignment.dueAt, true)}
            leading={<ClipboardList size={20} color={palette.primary}/>}
            onPress={() => navigate({ type: 'assignment', id: assignment.id, offeringId })}/>)}</Card>}
      </Section>
      <Button label="See all my grades" variant="outline" onPress={() => navigate({ type: 'grades' })}/>
    </>}</QueryState>
  </Page>;
}

export function TeacherClass({ client, offeringId, navigate }: {
  client: DistrictClient; offeringId: string; navigate: (d: Detail) => void;
}) {
  const palette = usePalette();
  const [screen, setScreen] = useState<'assignments' | 'roster'>('assignments');
  const [state, reload] = useLoad('teacher-class:' + offeringId + ':' + screen, async () => {
    const [offerings, records] = await Promise.all([
      client.teacherClasses(),
      screen === 'assignments' ? client.teacherAssignments(offeringId) : client.teacherRoster(offeringId),
    ]);
    return { course: offerings.find((c) => c.offering.id === offeringId), records };
  });
  return <Page refresh={reload}>
    <QueryState state={state} retry={reload}>{(data) => <>
      <Title subtitle={data.course?.offering.sectionName}> {data.course?.course.title || 'Classroom'} </Title>
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 22 }}>
        <View style={{ flex: 1 }}><Button label="Assignments" variant={screen === 'assignments' ? 'primary' : 'outline'}
          onPress={() => setScreen('assignments')}/></View>
        <View style={{ flex: 1 }}><Button label="Roster" variant={screen === 'roster' ? 'primary' : 'outline'}
          onPress={() => setScreen('roster')}/></View>
      </View>
      {screen === 'assignments' ? <Section title="Published assignments">
        {(data.records as Assignment[]).length === 0 ?
          <Placeholder title="Nothing published" message="Open Teacher Studio in your AI workspace to author assignments."/> :
          <Card>{(data.records as Assignment[]).map((assignment) => <Item key={assignment.id}
            title={assignment.title} detail={'Due ' + dateLabel(assignment.dueAt, true)}
            leading={<ClipboardCheck size={21} color={palette.primary}/>}
            onPress={() => navigate({ type: 'teacher-assignment', id: assignment.id, offeringId })}/>)}</Card>}
      </Section> : <Section title="Class roster">
        {(data.records as { enrollment: { principalId: string }; displayName: string }[]).length === 0 ?
          <Placeholder title="No students" message="Your roster will appear once your district enrolls students."/> :
          <Card>{(data.records as { enrollment: { principalId: string }; displayName: string }[])
            .map((member) => <Item key={member.enrollment.principalId} title={member.displayName}
              detail="Enrolled student" leading={<Users color={palette.teal} size={20}/>}/>)}</Card>}
      </Section>}
      <Card style={{ gap: 9, marginBottom: 24 }}>
        <Text style={{ color: palette.ink, fontWeight: '800' }}>More teaching tools</Text>
        <Text style={{ color: palette.muted, lineHeight: 20, fontSize: 13 }}>
          Course authoring, rubrics, quizzes, moderation, and advanced gradebook settings remain available
          in the full EducateOS Teacher Studio through your workspace.
        </Text>
      </Card>
    </>}</QueryState>
  </Page>;
}

export function FamilyChild({ client, studentId, navigate }: {
  client: DistrictClient; studentId: string; navigate: (d: Detail) => void;
}) {
  const palette = usePalette();
  const [result, reload] = useLoad('family:' + studentId, () => client.guardianClasses(studentId));
  return <Page refresh={reload}>
    <Title subtitle="Only classes and information your school has approved for your guardian relationship.">Family learning</Title>
    <QueryState state={result} retry={reload} empty={(v) => v.length === 0} emptyText="No linked classes available.">
      {(data) => <View style={{ gap: 12 }}>{data.map((entry) => <Card key={entry.offering.id}>
        <Item title={entry.course.title} detail={entry.offering.sectionName}
          leading={<BookOpen color={palette.primary} size={20}/>}
          onPress={() => navigate({ type: 'family-class', studentId, offeringId: entry.offering.id })}/>
      </Card>)}</View>}
    </QueryState>
  </Page>;
}

export function FamilyClass({ client, studentId, offeringId }: {
  client: DistrictClient; studentId: string; offeringId: string;
}) {
  const palette = usePalette();
  const [result, reload] = useLoad('family-class:' + studentId + ':' + offeringId,
    () => client.guardianClass(studentId, offeringId));
  return <Page refresh={reload}>
    <QueryState state={result} retry={reload}>{(data) => <>
      <Title subtitle={data.offering.sectionName}>{data.course.title}</Title>
      <Section title="Assignments and official grades">
        {data.assignments.length === 0 ? <Placeholder title="No published work" message="Your child's assignments will appear here."/> :
          <Card>{data.assignments.map(({ assignment, grades }) => {
            const grade = grades.at(-1);
            return <Item key={assignment.id} title={assignment.title}
              detail={'Due ' + dateLabel(assignment.dueAt)}
              leading={<FileText size={20} color={palette.primary}/>}
              trailing={<Chip label={grade ? grade.score.points + '/' + grade.score.maxPoints : 'Not graded'}
                tone={grade ? 'green' : 'neutral'}/>}/>;
          })}</Card>}
      </Section>
      {data.announcements && data.announcements.length > 0 && <Section title="Announcements">
        <Card>{data.announcements.map(({ announcement }) => <Item key={announcement.id}
          title={announcement.title} detail={announcement.body}
          leading={<GraduationCap size={19} color={palette.primary}/>}/>)}</Card>
      </Section>}
      <Text style={{ color: palette.muted, fontSize: 12, lineHeight: 19 }}>
        Guardian access does not include student drafts, private submissions, or classroom discussions.
      </Text>
    </>}</QueryState>
  </Page>;
}
