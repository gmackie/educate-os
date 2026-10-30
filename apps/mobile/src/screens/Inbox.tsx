import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Bell, CheckCheck } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Detail, Notification } from '../types';
import { useLoad } from '../hooks/useLoad';
import { useAppState } from '../state/app-state';
import { usePalette } from '../ui/theme-context';
import { Button, Card, Chip, dateLabel, Item, Page, QueryState, Title } from '../ui/Primitives';

export function Inbox({ client, navigate, onChange }: {
  client: DistrictClient; navigate: (detail: Detail) => void; onChange?: () => void;
}) {
  const palette = usePalette();
  const { role } = useAppState();
  const [list, reload] = useLoad('inbox', () => client.notifications());
  const [saving, setSaving] = useState(false);
  const mark = async (ids: string[] | 'all') => {
    if (saving) return;
    setSaving(true);
    try { await client.markRead(ids); reload(); onChange?.(); }
    catch (e) { Alert.alert("Couldn't update messages", e instanceof Error ? e.message : 'Try again.'); }
    finally { setSaving(false); }
  };
  const open = (item: Notification) => {
    if (!item.readAt) void mark([item.id]);
    const staff = role === 'teacher';
    if (item.ref.assignmentId) navigate({
      type: staff ? 'teacher-assignment' : 'assignment', id: item.ref.assignmentId, offeringId: item.offeringId,
    });
    else if (item.ref.announcementId && !staff) navigate({ type: 'announcements' });
    else navigate({ type: staff ? 'teacher-class' : 'class', id: item.offeringId });
  };
  return <Page refresh={reload}>
    <Title subtitle="Updates from your school, without losing track of what matters.">Inbox</Title>
    <QueryState state={list} retry={reload}>{(data) => <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 18 }}>
        <Chip label={data.unread + ' unread'} tone={data.unread ? 'blue' : 'green'}/>
        {data.unread > 0 && <Button label="Mark all read" variant="quiet"
          disabled={saving} icon={<CheckCheck color={palette.primary} size={16}/>}
          onPress={() => void mark('all')}/>}
      </View>
      {data.notifications.length === 0 ?
        <Card><Text style={{ color: palette.muted, textAlign: 'center', padding: 20 }}>
          You're all caught up. School updates will show up here.
        </Text></Card> :
        <Card>{data.notifications.map((item) => <Item key={item.id}
          title={item.title}
          detail={item.kind.replaceAll('-', ' ') + ' · ' + dateLabel(item.occurredAt, true)}
          leading={<Bell size={20} color={item.readAt ? palette.subtle : palette.primary}/>}
          trailing={!item.readAt ? <Chip label="New"/> : undefined}
          onPress={() => open(item)}/>)}</Card>}
      <View style={{ paddingTop: 16 }}>
        <Text style={{ color: palette.muted, fontSize: 12, lineHeight: 20 }}>
          Updates never display private grades or feedback in their previews. Open a class to view that information.
        </Text>
      </View>
    </>}</QueryState>
  </Page>;
}
