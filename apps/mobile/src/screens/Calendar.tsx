import { useState } from 'react';
import { Text, View } from 'react-native';
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { CalendarEvent, Detail } from '../types';
import { useLoad } from '../hooks/useLoad';
import { palette } from '../theme';
import { Button, Card, Chip, dateLabel, Item, Page, QueryState, Section, Title } from '../ui/Primitives';

function beginningOfWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - weekday);
  return d;
}
function addDays(d: Date, n: number): Date {
  const copy = new Date(d); copy.setDate(copy.getDate() + n); return copy;
}
function groupByDay(events: CalendarEvent[]): [string, CalendarEvent[]][] {
  const groups = new Map<string, CalendarEvent[]>();
  for (const item of events) {
    const date = item.allDay ? item.start.slice(0, 10) : new Date(item.start).toLocaleDateString('en-CA');
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(item);
  }
  return [...groups].toSorted(([a], [b]) => a.localeCompare(b));
}
export function CalendarScreen({ client, navigate }: { client: DistrictClient; navigate: (detail: Detail) => void }) {
  const [start, setStart] = useState(() => beginningOfWeek(new Date()));
  const end = addDays(start, 28);
  const [cal, reload] = useLoad('calendar:' + start.toISOString(), () => client.calendar(start, end));
  const nextWeek = (n: number) => setStart((d) => addDays(d, n * 7));
  return <Page refresh={reload}>
    <Title subtitle="School deadlines, announcements, and term dates.">Calendar</Title>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      marginBottom: 20, gap: 10 }}>
      <Button label="Previous" variant="quiet" onPress={() => nextWeek(-1)}
        icon={<ChevronLeft size={16} color={palette.primary}/>}/>
      <View style={{ alignItems: 'center', flex: 1 }}>
        <Text style={{ color: palette.ink, fontWeight: '800', textAlign: 'center' }}>
          {dateLabel(start.toISOString())} – {dateLabel(addDays(start, 27).toISOString())}
        </Text>
        <Text style={{ color: palette.muted, fontSize: 11 }}>Four-week agenda</Text>
      </View>
      <Button label="Next" variant="quiet" onPress={() => nextWeek(1)}
        icon={<ChevronRight size={16} color={palette.primary}/>}/>
    </View>
    <QueryState state={cal} retry={reload} empty={(v) => v.events.length === 0}
      emptyText="No upcoming school events in the next four weeks.">
      {(data) => groupByDay(data.events).map(([day, events]) => <Section key={day}
        title={dateLabel(day + 'T12:00:00')}>
        <Card>{events.map((event) => <Item key={event.uid}
          title={event.title} detail={event.allDay ? 'All day' : dateLabel(event.start, true)}
          leading={event.kind === 'assignment-due'
            ? <Clock size={20} color={palette.amber}/> : <CalendarDays size={20} color={palette.primary}/>}
          trailing={<Chip label={event.kind.replaceAll('-', ' ')} tone="neutral"/>}
          onPress={event.assignmentId && event.offeringId ?
            () => navigate({ type: 'assignment', id: event.assignmentId!, offeringId: event.offeringId! })
            : event.offeringId ? () => navigate({ type: 'class', id: event.offeringId! }) : undefined}/>)}</Card>
      </Section>)}
    </QueryState>
    <Button label="Return to current week" variant="outline" onPress={() => setStart(beginningOfWeek(new Date()))}/>
  </Page>;
}
