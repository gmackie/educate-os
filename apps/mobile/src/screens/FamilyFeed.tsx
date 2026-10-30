import { useState } from 'react';
import { Text, View } from 'react-native';
import { Clock, Megaphone } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Announcement, Detail, GuardianChild } from '../types';
import { useLoad } from '../hooks/useLoad';
import { usePalette } from '../ui/theme-context';
import { Markdown } from '../ui/Markdown';
import { Card, Chip, dateLabel, Item, Page, QueryState, Section, shortName, Title } from '../ui/Primitives';

/**
 * A family's calendar and news. The district's own calendar and notifications cover only the
 * caller's classes, and a guardian has none, so these are gathered from each child's current
 * classes (`/api/guardian/children/:id/offerings/:offering`), which carry due dates and announcements.
 */
export type FamilyDue = { child: GuardianChild; offeringId: string; course: string; id: string; title: string; dueAt: string; graded: boolean };
export type FamilyNews = { child: GuardianChild; offeringId: string; course: string; announcement: Announcement['announcement'] };
export type FamilyFeed = { children: GuardianChild[]; due: FamilyDue[]; news: FamilyNews[] };

export async function loadFamilyFeed(client: DistrictClient): Promise<FamilyFeed> {
  const children = await client.guardianChildren();
  const perChild = await Promise.all(children.map(async (child) => {
    const classes = (await client.guardianClasses(child.studentPrincipalId).catch(() => []))
      .filter((c) => c.term?.state !== 'closed');
    return Promise.all(classes.map((c) => client.guardianClass(child.studentPrincipalId, c.offering.id)
      .then((course) => ({ child, course }), () => null)));
  }));
  const due: FamilyDue[] = [];
  const news: FamilyNews[] = [];
  for (const entry of perChild.flat()) {
    if (!entry) continue;
    const { child, course } = entry;
    const label = course.course.title;
    for (const { assignment, grades } of course.assignments) {
      due.push({ child, offeringId: course.offering.id, course: label, id: assignment.id, title: assignment.title,
        dueAt: assignment.dueAt, graded: grades.length > 0 });
    }
    for (const announcement of course.announcements ?? []) {
      news.push({ child, offeringId: course.offering.id, course: label, announcement });
    }
  }
  return {
    children,
    due: due.toSorted((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)),
    news: news.toSorted((a, b) => Date.parse(b.announcement.publishAt) - Date.parse(a.announcement.publishAt)),
  };
}

/** Assignments due from today on, for the family's agenda and home. */
export function upcoming(feed: FamilyFeed, now = Date.now()): FamilyDue[] {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  return feed.due.filter((d) => Date.parse(d.dueAt) >= today.getTime());
}

const who = (feed: FamilyFeed, child: GuardianChild) => feed.children.length > 1 ? shortName(child.displayName) + ' · ' : '';

/** The family's Agenda tab: what each child has due, by day. */
export function FamilyAgenda({ client, navigate }: { client: DistrictClient; navigate: (d: Detail) => void }) {
  const palette = usePalette();
  const [state, reload] = useLoad('family-agenda', () => loadFamilyFeed(client));
  return <Page refresh={reload}>
    <Title subtitle="What your children have due, by day.">Agenda</Title>
    <QueryState state={state} retry={reload} empty={(feed) => upcoming(feed).length === 0}
      emptyText="Nothing is due in your children's classes right now.">{(feed) => {
      const days = new Map<string, FamilyDue[]>();
      for (const item of upcoming(feed)) {
        const day = new Date(item.dueAt).toLocaleDateString('en-CA');
        days.set(day, [...days.get(day) ?? [], item]);
      }
      return [...days].map(([day, items]) => <Section key={day} title={dateLabel(day + 'T12:00:00')}>
        <Card>{items.map((item) => <Item key={item.child.studentPrincipalId + item.id} title={item.title}
          detail={who(feed, item.child) + item.course + ' · ' + dateLabel(item.dueAt, true)}
          leading={<Clock size={20} color={palette.amber}/>}
          trailing={item.graded ? <Chip label="Graded" tone="green"/> : undefined}
          onPress={() => navigate({ type: 'family-class', studentId: item.child.studentPrincipalId, offeringId: item.offeringId })}/>)}</Card>
      </Section>);
    }}</QueryState>
  </Page>;
}

/** The family's Inbox: announcements from their children's classes, newest first. */
export function FamilyInbox({ client, navigate }: { client: DistrictClient; navigate: (d: Detail) => void }) {
  const palette = usePalette();
  const [state, reload] = useLoad('family-inbox', () => loadFamilyFeed(client));
  const [open, setOpen] = useState<string | null>(null);
  return <Page refresh={reload}>
    <Title subtitle="News from your children's teachers.">Inbox</Title>
    <QueryState state={state} retry={reload} empty={(feed) => feed.news.length === 0}
      emptyText="No announcements from your children's classes yet.">{(feed) => <Card>
      {feed.news.map((item) => {
        const key = item.child.studentPrincipalId + item.announcement.id;
        return <View key={key}>
          <Item title={item.announcement.title}
            detail={who(feed, item.child) + item.course + ' · ' + dateLabel(item.announcement.publishAt)}
            leading={<Megaphone size={20} color={palette.teal}/>} onPress={() => setOpen(open === key ? null : key)}/>
          {open === key && <View style={{ paddingBottom: 14, gap: 10 }}>
            <Markdown source={item.announcement.body}/>
            <Text accessibilityRole="link" style={{ color: palette.primary, fontWeight: '700' }}
              onPress={() => navigate({ type: 'family-class', studentId: item.child.studentPrincipalId, offeringId: item.offeringId })}>
              Open {item.course}</Text>
          </View>}
        </View>;
      })}
    </Card>}</QueryState>
  </Page>;
}
