import { Pressable, Text, View } from 'react-native';
import { Bell, BookOpen, CalendarDays, ChevronRight, ClipboardList, Clock, Megaphone, Sparkles, Users } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Activity, Announcement, CalendarEvent, ClassItem, Detail, GuardianChild, Notifications, Principal, Tab } from '../types';
import { useLoad } from '../hooks/useLoad';
import { usePalette } from '../ui/theme-context';
import { Card, dateLabel, Eyebrow, Item, Page, QueryState, Section, shortName, Title } from '../ui/Primitives';

type Upcoming = { assignment: Activity['assignment']; course: ClassItem };
type Home = { classes: ClassItem[]; notifications: Notifications | null; upcoming: Upcoming[];
  announcements: Announcement[]; children: GuardianChild[]; agenda: CalendarEvent[] };

const EMPTY_NOTIFICATIONS: Notifications = { notifications: [], unread: 0 };

/** Student/teacher home only reads data the district already authorizes for the principal. */
async function loadHome(api: DistrictClient, me: Principal): Promise<Home> {
  const now = new Date();
  const [classes, notifications, announcements, children, agenda] = await Promise.all([
    me.kind === 'student' ? api.studentClasses() :
      me.kind === 'staff' ? api.teacherClasses().catch(() => []) : Promise.resolve([]),
    api.notifications().catch(() => EMPTY_NOTIFICATIONS),
    me.kind === 'student' ? api.studentAnnouncements().catch(() => []) : Promise.resolve([]),
    me.kind === 'guardian' ? api.guardianChildren() : Promise.resolve([]),
    // The calendar folds into Today as a one-week agenda for students and teachers.
    me.kind === 'guardian' ? Promise.resolve([]) :
      api.calendar(now, new Date(now.getTime() + 7 * 86_400_000)).then((c) => c.events).catch(() => []),
  ]);
  const assignments = await Promise.all(classes.slice(0, 12).map(async (course) => {
    const list = me.kind === 'student'
      ? await api.studentActivities(course.offering.id).catch(() => [])
      : (await api.teacherAssignments(course.offering.id).catch(() => [])).map((assignment) => ({ assignment }));
    return list.map(({ assignment }) => ({ assignment, course }));
  }));
  const upcoming = assignments.flat()
    .filter(({ assignment }) => Date.parse(assignment.dueAt) >= now.getTime() - 86_400_000)
    .toSorted((a, b) => Date.parse(a.assignment.dueAt) - Date.parse(b.assignment.dueAt))
    .slice(0, 8);
  return { classes, notifications, upcoming, announcements, children,
    agenda: agenda.toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, 8) };
}

function Stat({ count, label, onPress }: { count: number; label: string; onPress: () => void }) {
  const palette = usePalette();
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={count + ' ' + label}
    style={{ flex: 1, backgroundColor: palette.raised, borderRadius: 20, borderColor: palette.line, borderWidth: 1,
      padding: 17, gap: 5 }}>
    <Text style={{ fontSize: 26, fontWeight: '800', color: palette.ink }}>{count}</Text>
    <Text style={{ fontSize: 12, color: palette.muted, fontWeight: '600' }}>{label}</Text>
  </Pressable>;
}

export function Today({ client, me, navigate, changeTab, showAi = true }: {
  client: DistrictClient; me: Principal; navigate: (detail: Detail) => void; changeTab: (tab: Tab | 'calendar') => void;
  showAi?: boolean;
}) {
  const palette = usePalette();
  const [home, retry] = useLoad('home:' + me.principalId, () => loadHome(client, me));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const role = me.kind === 'student' ? 'Your learning day' : me.kind === 'guardian' ? 'Your family' :
    me.kind === 'staff' ? 'Your classroom' : 'Your district';

  return <Page refresh={retry}>
    <Eyebrow>{role}</Eyebrow>
    <Title subtitle="Everything important, all in one place.">{greeting}, {shortName(me.displayName)}.</Title>
    <QueryState state={home} retry={retry}>{(data) => <>
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 28 }}>
        <Stat count={me.kind === 'guardian' ? data.children.length : data.classes.length}
          label={me.kind === 'guardian' ? 'Children' : 'Classes'} onPress={() => changeTab('classes')}/>
        <Stat count={data.notifications?.unread ?? 0} label="New updates" onPress={() => changeTab('inbox')}/>
        <Stat count={data.upcoming.length} label="Coming due" onPress={() => changeTab(me.kind === 'guardian' ? 'agenda' : 'calendar')}/>
      </View>

      {data.notifications && data.notifications.unread > 0 && <Pressable onPress={() => changeTab('inbox')}
        accessibilityRole="button" accessibilityLabel="View unread school updates"
        style={{ padding: 17, borderRadius: 20, flexDirection: 'row', gap: 13, alignItems: 'center',
          backgroundColor: palette.primarySoft, marginBottom: 27 }}>
        <Bell size={23} color={palette.primary}/>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: palette.ink }}>
            {data.notifications.unread} unread {data.notifications.unread === 1 ? 'update' : 'updates'}
          </Text>
          <Text style={{ color: palette.primary, fontSize: 12 }}>Messages and announcements from your school</Text>
        </View><ChevronRight size={18} color={palette.primary}/>
      </Pressable>}

      {me.kind === 'guardian' ? <Section title="My children">
        {data.children.length === 0 ? <Card><Text style={{ color: palette.muted }}>No linked children yet. Ask your school to confirm your family relationship.</Text></Card> :
          <Card>{data.children.map((child) => <Item key={child.studentPrincipalId} title={child.displayName}
            detail="See classes and released grades" leading={<Users color={palette.primary} size={20}/>}
            onPress={() => navigate({ type: 'family-child', id: child.studentPrincipalId })}/>)}</Card>}
      </Section> : null}

      {me.kind !== 'guardian' && <Section title={me.kind === 'staff' ? 'My classrooms' : 'My courses'}
        trailing={<Pressable onPress={() => changeTab(me.kind === 'guardian' ? 'family' : 'classes')} accessibilityRole="button">
          <Text style={{ color: palette.primary, fontSize: 13, fontWeight: '700' }}>See all</Text>
        </Pressable>}>
        {data.classes.length === 0
          ? <Card><Text style={{ color: palette.muted }}>Your school hasn't assigned any classes to this account.</Text></Card>
          : <Card>{data.classes.slice(0, 4).map((entry) => <Item key={entry.offering.id}
            title={entry.course.title} detail={[entry.offering.sectionName, entry.term?.name].filter(Boolean).join(' · ')}
            leading={<BookOpen color={palette.primary} size={20}/>}
            onPress={() => navigate({ type: me.kind === 'staff' ? 'teacher-class' : 'class', id: entry.offering.id })}/>)}</Card>}
      </Section>}

      {data.upcoming.length > 0 && <Section title={me.kind === 'staff' ? 'Upcoming class deadlines' : 'Coming up'}>
        <Card>{data.upcoming.map(({ assignment, course }) => <Item key={assignment.id}
          title={assignment.title} detail={course.course.title + ' · ' + dateLabel(assignment.dueAt, true)}
          leading={<ClipboardList size={19} color={palette.amber}/>}
          onPress={() => navigate(me.kind === 'staff'
            ? { type: 'teacher-class', id: assignment.offeringId }
            : { type: 'assignment', id: assignment.id, offeringId: assignment.offeringId })}/>)}</Card>
      </Section>}

      {me.kind !== 'guardian' && <Section title="This week"
        trailing={<Pressable onPress={() => changeTab('calendar')} accessibilityRole="button">
          <Text style={{ color: palette.primary, fontSize: 13, fontWeight: '700' }}>Calendar</Text>
        </Pressable>}>
        {data.agenda.length === 0
          ? <Card><Text style={{ color: palette.muted }}>Nothing on the calendar for the next seven days.</Text></Card>
          : <Card>{data.agenda.map((event) => <Item key={event.uid} title={event.title}
            detail={event.allDay ? dateLabel(event.start.slice(0, 10) + 'T12:00:00') + ' · All day' : dateLabel(event.start, true)}
            leading={event.kind === 'assignment-due' ? <Clock size={19} color={palette.amber}/> : <CalendarDays size={19} color={palette.primary}/>}
            onPress={event.assignmentId && event.offeringId
              ? () => navigate({ type: me.kind === 'staff' ? 'teacher-assignment' : 'assignment', id: event.assignmentId!, offeringId: event.offeringId! })
              : event.offeringId ? () => navigate({ type: me.kind === 'staff' ? 'teacher-class' : 'class', id: event.offeringId! }) : undefined}/>)}</Card>}
      </Section>}

      {data.announcements.length > 0 && <Section title="Latest announcements">
        <Card>{data.announcements.slice(0, 3).map(({ announcement, courseLabel }) =>
          <Item key={announcement.id} title={announcement.title}
            detail={courseLabel + ' · ' + dateLabel(announcement.publishAt)}
            leading={<Megaphone size={19} color={palette.teal}/>}
            onPress={() => navigate({ type: 'announcements' })}/>)}</Card>
      </Section>}

      {showAi && <Section title="Your AI workspace">
        <Pressable onPress={() => changeTab('ai')} accessibilityRole="button"
          style={{ borderRadius: 22, padding: 20, backgroundColor: palette.navy,
            flexDirection: 'row', alignItems: 'center', gap: 15 }}>
          <Sparkles size={28} color="#FFFFFF"/>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ fontSize: 17, color: '#FFFFFF', fontWeight: '800' }}>Study, create, explore</Text>
            <Text style={{ fontSize: 12, color: '#C5D3F4', lineHeight: 19 }}>Your school's AI agents and interactive learning tools.</Text>
          </View><ChevronRight size={19} color="#FFFFFF"/>
        </Pressable>
      </Section>}
    </>}</QueryState>
  </Page>;
}
